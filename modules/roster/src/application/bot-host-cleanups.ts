import type { SQL } from "bun";
import { HermesClientError, type HermesClient } from "@openedbot/hermes";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { isGreetingSessionKey } from "../domain/bot-greeting-session";
import { publicBot } from "../domain/bot-dto";
import { readBotRows } from "../sql/bots";
import type { BotHostCleanupRow } from "../sql/bot-host-cleanups";

export const BOT_HOST_CLEANUP_LEASE_SECONDS = 240;
/**
 * Hermes' background title writer can re-create a session row after its
 * DELETE. A deleted session whose host profile survives is
 * deleted again after this delay, until a pass finds it absent.
 */
export const BOT_HOST_CLEANUP_VERIFY_DELAY_SECONDS = 60;
export const BOT_HOST_CLEANUP_VERIFY_PASSES = 5;
export type BotHostCleanupClient = Pick<HermesClient, "removeSession" | "hostProfileInventory" | "hostDeleteProfile">;
export type BotHostCleanupDependencies = { client(runtimeId: string, profile: string | null): BotHostCleanupClient; signal?: AbortSignal };
const CLEANUP_FAILED = { code: "BOT_HOST_CLEANUP_FAILED", message: "Le nettoyage de ce bot sur votre serveur n’a pas abouti." } as const;

export async function retryBotHostCleanup(db: Db, organizationId: string, botId: string) {
  return withTenant(db, organizationId, async (tx) => {
    const changed = await tx<Array<{ id: string }>>`update bot_host_cleanups
      set status = 'queued', attempts = 0, next_attempt_at = now(), error = null,
          finished_at = null, lease_owner = null, lease_expires_at = null, updated_at = now()
      where organization_id = ${organizationId} and bot_id = ${botId} and status = 'failed'
      returning id`;
    if (!changed.length) {
      const exists = await tx<Array<{ status: string }>>`select status from bot_host_cleanups
        where organization_id = ${organizationId} and bot_id = ${botId}`;
      if (!exists.length) throw new HttpError(404, "BOT_HOST_CLEANUP_NOT_FOUND", "Nettoyage du bot introuvable.");
      throw new HttpError(409, "BOT_HOST_CLEANUP_NOT_FAILED", "Le nettoyage de ce bot n’est pas en échec.");
    }
    const rows = await readBotRows(tx, organizationId, botId);
    return rows[0] ? publicBot({ ...rows[0], hostCleanupStatus: "pending" }) : null;
  });
}

export async function lockBotHostCleanupForRestore(db: Db, organizationId: string, botId: string): Promise<"none" | "queued-cancelled" | "running"> {
  return withTenant(db, organizationId, async (tx) => {
    const rows = await tx<Array<{ id: string; status: BotHostCleanupRow["status"]; live: boolean }>>`
      select id, status, (status = 'running' and lease_expires_at > now()) as live
        from bot_host_cleanups where organization_id = ${organizationId} and bot_id = ${botId}
          and status in ('queued','running','failed')
        order by created_at desc, id desc limit 1 for update`;
    const row = rows[0];
    if (!row) return "none";
    if (row.live) return "running";
    if (row.status === "queued" || row.status === "failed" || row.status === "running") {
      await tx`update bot_host_cleanups set status = 'cancelled', lease_owner = null,
        lease_expires_at = null, finished_at = now(), updated_at = now()
        where id = ${row.id} and status = ${row.status}`;
      return row.status === "queued" ? "queued-cancelled" : "none";
    }
    return "none";
  });
}

export async function claimBotHostCleanup(db: SQL, workerId: string): Promise<BotHostCleanupRow | null> {
  const rows = await db<BotHostCleanupRow[]>`with candidate as (
      select id from bot_host_cleanups
       where ((status = 'queued' and next_attempt_at <= now())
          or (status = 'running' and lease_expires_at < now()))
       order by next_attempt_at, id for update skip locked limit 1
    ) update bot_host_cleanups c set status = 'running', lease_owner = ${workerId},
      lease_generation = c.lease_generation + 1,
      lease_expires_at = now() + (${BOT_HOST_CLEANUP_LEASE_SECONDS} * interval '1 second'), updated_at = now()
      from candidate where c.id = candidate.id returning c.*`;
  return rows[0] ?? null;
}

export async function executeBotHostCleanup(db: SQL, job: BotHostCleanupRow, deps: BotHostCleanupDependencies): Promise<void> {
  if (deps.signal?.aborted) return;
  const host = deps.client(job.runtime_id, job.session_profile);
  // An early greeting session (bots created before the greeting waited for
  // their profile) lives on the default profile, not the bot's.
  const sessionHost = (sessionId: string) =>
    isGreetingSessionKey(sessionId) && job.session_profile ? deps.client(job.runtime_id, null) : host;
  const holdLease = async () => {
    const rows = await db<Array<{ id: string }>>`update bot_host_cleanups
      set lease_expires_at = now() + (${BOT_HOST_CLEANUP_LEASE_SECONDS} * interval '1 second'), updated_at = now()
      where id = ${job.id} and status = 'running' and lease_owner = ${job.lease_owner}
        and lease_generation = ${job.lease_generation} and lease_expires_at > now() returning id`;
    return rows.length > 0;
  };
  const finish = async (success: boolean, _error: { code: string; message: string } | null) => {
    const nextAttempt = job.attempts + 1;
    const failed = !success && nextAttempt >= 10;
    const status = success ? "succeeded" : failed ? "failed" : "queued";
    const finalError = success ? null : failed ? CLEANUP_FAILED : null;
    const rows = await db<Array<{ id: string }>>`update bot_host_cleanups set status = ${status},
      attempts = case when ${success} then attempts else attempts + 1 end,
      verify_session_ids = case when ${success} then '{}'::text[] else verify_session_ids end,
      next_attempt_at = case when ${status} = 'queued' then now() + (least((attempts + 1) * 30, 600) * interval '1 second') else next_attempt_at end,
      error = ${finalError}::jsonb,
      finished_at = case when ${status} = 'queued' then null else now() end,
      lease_owner = null, lease_expires_at = null, updated_at = now()
      where id = ${job.id} and status = 'running' and lease_owner = ${job.lease_owner}
        and lease_generation = ${job.lease_generation} and lease_expires_at > now() returning id`;
    if (rows.length) console.info(JSON.stringify({ event: `bot_host_cleanup.${success ? "succeeded" : failed ? "failed" : "retry"}`, botId: job.bot_id, organizationId: job.organization_id, generation: job.lease_generation, attempt: success ? job.attempts : nextAttempt, ...(finalError ? { code: finalError.code } : {}) }));
    return rows.length > 0;
  };
  const refuse = async (error: unknown) => {
    const code = error instanceof HermesClientError ? error.code : "UNEXPECTED";
    console.info(JSON.stringify({ event: "bot_host_cleanup.host_refused", botId: job.bot_id, organizationId: job.organization_id, code }));
    await finish(false, { code, message: CLEANUP_FAILED.message });
  };
  // Waits, then re-reads: requeued without counting an attempt.
  const scheduleVerification = async (passes: number) => {
    const rows = await db<Array<{ id: string }>>`update bot_host_cleanups set status = 'queued',
      verify_passes = ${passes},
      next_attempt_at = now() + (${BOT_HOST_CLEANUP_VERIFY_DELAY_SECONDS} * interval '1 second'),
      finished_at = null, lease_owner = null, lease_expires_at = null, updated_at = now()
      where id = ${job.id} and status = 'running' and lease_owner = ${job.lease_owner}
        and lease_generation = ${job.lease_generation} and lease_expires_at > now() returning id`;
    if (rows.length) console.info(JSON.stringify({ event: "bot_host_cleanup.verify_scheduled", botId: job.bot_id, organizationId: job.organization_id, passes }));
  };
  // A session on a profile this job deletes goes with the profile; any other
  // (default profile, a profile the bot does not own) must be proven gone.
  const outlivesJob = (sessionId: string) => !job.profile || isGreetingSessionKey(sessionId);
  const verifyIds = new Set(job.verify_session_ids ?? []);
  console.info(JSON.stringify({ event: "bot_host_cleanup.started", botId: job.bot_id, organizationId: job.organization_id, generation: job.lease_generation }));
  try {
    for (const sessionId of job.session_ids) {
      if (!(await holdLease())) return;
      try {
        await sessionHost(sessionId).removeSession(sessionId);
      } catch (error) {
        if (!(error instanceof HermesClientError) || (error.code !== "HERMES_RUN_MISSING" && error.status !== 404)) { await refuse(error); return; }
      }
      const verify = outlivesJob(sessionId);
      const rows = await db<Array<{ id: string }>>`update bot_host_cleanups
        set session_ids = array_remove(session_ids, ${sessionId}),
            verify_session_ids = case when ${verify}
              then array_append(array_remove(verify_session_ids, ${sessionId}), ${sessionId})
              else verify_session_ids end,
            updated_at = now()
        where id = ${job.id} and status = 'running' and lease_owner = ${job.lease_owner}
          and lease_generation = ${job.lease_generation} and lease_expires_at > now() returning id`;
      if (!rows.length) return;
      if (verify) verifyIds.add(sessionId);
    }
    // Already proven gone by an earlier pass: the name may belong to a new bot
    // by now (its provision no longer waits for this verification), so a
    // later pass must never delete it.
    if (job.profile && !job.profile_removed_at) {
      if (!(await holdLease())) return;
      const before = await host.hostProfileInventory();
      if (before.profiles.some((profile) => profile.name === job.profile)) {
        if (!(await holdLease())) return;
        try { await host.hostDeleteProfile(job.profile); }
        catch (error) {
          if (!(error instanceof HermesClientError) || error.code !== "PROFILE_NOT_FOUND") { await refuse(error); return; }
        }
        if (!(await holdLease())) return;
        const after = await host.hostProfileInventory();
        if (after.profiles.some((profile) => profile.name === job.profile)) {
          console.info(JSON.stringify({ event: "bot_host_cleanup.host_refused", botId: job.bot_id, organizationId: job.organization_id, code: "PROFILE_UNVERIFIED" }));
          await finish(false, { code: "PROFILE_UNVERIFIED", message: CLEANUP_FAILED.message });
          return;
        }
      }
      // Proven absent: from now on a new bot may take this name at once.
      const recorded = await db<Array<{ id: string }>>`update bot_host_cleanups
        set profile_removed_at = now(), updated_at = now()
        where id = ${job.id} and status = 'running' and lease_owner = ${job.lease_owner}
          and lease_generation = ${job.lease_generation} and lease_expires_at > now() returning id`;
      if (!recorded.length) return;
    }
    if (verifyIds.size === 0) { await finish(true, null); return; }
    // This pass deleted sessions: give a late writer time before re-reading.
    if (job.session_ids.length > 0) { await scheduleVerification(job.verify_passes ?? 0); return; }
    // Every id stays listed until ONE pass finds them all absent: a session
    // found absent now can still come back before the next one.
    let resurrected = 0;
    for (const sessionId of verifyIds) {
      if (!(await holdLease())) return;
      // `true`: the session had come back and is deleted again.
      if (await sessionHost(sessionId).removeSession(sessionId)) resurrected += 1;
    }
    if (resurrected === 0) { await finish(true, null); return; }
    console.info(JSON.stringify({ event: "bot_host_cleanup.session_resurrected", botId: job.bot_id, organizationId: job.organization_id, count: resurrected }));
    const passes = (job.verify_passes ?? 0) + 1;
    if (passes >= BOT_HOST_CLEANUP_VERIFY_PASSES) {
      await finish(false, { code: "SESSION_RESURRECTED", message: CLEANUP_FAILED.message });
      return;
    }
    await scheduleVerification(passes);
  } catch (error) {
    if (error instanceof HermesClientError) {
      const code = error.code;
      console.info(JSON.stringify({ event: "bot_host_cleanup.host_refused", botId: job.bot_id, organizationId: job.organization_id, code }));
      await finish(false, { code, message: CLEANUP_FAILED.message });
      return;
    }
    console.info(JSON.stringify({ event: "bot_host_cleanup.host_refused", botId: job.bot_id, organizationId: job.organization_id, code: "UNEXPECTED" }));
    await finish(false, { code: "UNEXPECTED", message: CLEANUP_FAILED.message });
  }
}
