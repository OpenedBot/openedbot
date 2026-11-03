import type { SQL, TransactionSQL } from "bun";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { RuntimeProfileDeleteDto } from "@openedbot/contracts-api";
import { compactionSessionKey } from "@openedbot/conversation/domain/thread-compaction";
import { threadSessionKeys } from "@openedbot/conversation/domain/thread-session";
import { cancelMaintenanceRunsTx, isMaintenanceStepKind } from "@openedbot/execution/application/run-cancellation";
import { HermesClientError, type HermesClient, type HermesProfileInventory } from "@openedbot/hermes";
import { withTenant } from "@openedbot/platform-db";
import { deleteBotAfterHostProfileDelete } from "@openedbot/roster/sql/bot-import";
import { workflowSessionKey } from "@openedbot/roster/domain/autonomous-workflow";
import { personaDraftSessionKey } from "@openedbot/roster/domain/persona-draft";
import { OPENEDBOT_SERVICE_PROFILES } from "@openedbot/runtimes/domain/runtime-contract";
import { ProfileDeleteError } from "../domain/errors";

export const PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const PROFILE_INVENTORY_TIMEOUT_MS = 60_000;
export const PROFILE_DELETE_MAX = 64;

export type HostProfileDeleteClient = Pick<HermesClient, "hostProfileInventory" | "hostDeleteProfile" | "deleteSession">;

type ActiveBotRun = { id: string; stepKind: string | null; threadId: string };

/**
 * Suppression d'un profil sur le disque de l'hôte. Si un bot (y compris
 * archivé) porte ce hermes_profile, ses sessions runtime partent d'abord ;
 * un échec de purge ou une relue qui voit encore le slug laisse la ligne SQL.
 *
 * Twin of the former inline DELETE /profiles/:slug handler: the HTTP route and
 * the delete-job worker share this function so a bulk job cannot skip a guard.
 */
export async function deleteHostProfile(
  db: SQL,
  organizationId: string,
  slug: string,
  deps: {
    host: HostProfileDeleteClient;
    sessionClient: (profile: string) => Pick<HermesClient, "deleteSession">;
    timeoutMs?: number;
  },
): Promise<RuntimeProfileDeleteDto> {
  if (slug === "default" || !PROFILE_SLUG_PATTERN.test(slug) || OPENEDBOT_SERVICE_PROFILES.has(slug)) {
    throw new ProfileDeleteError(400, "PROFILE_INVALID", "Ce slug de profil n’est pas valide.");
  }
  const timeoutMs = deps.timeoutMs ?? PROFILE_INVENTORY_TIMEOUT_MS;
  let inventory: HermesProfileInventory;
  try {
    inventory = await withDeadline(deps.host.hostProfileInventory(), timeoutMs);
  } catch (error) {
    throw hostDeleteError(error);
  }
  if (!inventory.profiles.some((profile) => profile.name === slug)) {
    throw new ProfileDeleteError(404, "PROFILE_NOT_FOUND", "Ce profil n’existe pas sur l’hôte.");
  }

  const linked = await withTenant(db, organizationId, async (tx) =>
    tx<Array<{ id: string }>>`
      select id from bots
       where organization_id = ${organizationId} and hermes_profile = ${slug}
    `,
  );
  const botId = linked[0]?.id ?? null;

  let purgedSessions = 0;
  let failedSessions = 0;
  if (botId) {
    const scope = await withTenant(db, organizationId, async (tx) => {
      await assertLinkedBotDeletable(tx, organizationId, botId);
      const threads = await tx<Array<{ sessionId: string; threadId: string; sessionGeneration: number }>>`
        select hermes_session_id as "sessionId", id as "threadId", hermes_session_generation as "sessionGeneration" from threads
         where organization_id = ${organizationId} and bot_id = ${botId}
      `;
      const workflows = await tx<Array<{ workflowId: string }>>`
        select distinct workflow_id as "workflowId" from runs
         where organization_id = ${organizationId} and workflow_id is not null
           and (bot_id = ${botId} or caller_bot_id = ${botId} or handoff_target_bot_id = ${botId})
      `;
      return { threads, workflows };
    });
    const sessions = botRuntimeSessionIds(organizationId, botId, scope);
    const purged = await purgeRuntimeSessions(deps.sessionClient(slug), sessions);
    if (purged.failed.length > 0) {
      throw new ProfileDeleteError(
        502,
        "RUNTIME_PURGE_FAILED",
        purged.reason
          ?? "Les sessions liées à ce profil n’ont pas pu être effacées sur votre runtime Hermes. La suppression du profil n’a pas été tentée.",
      );
    }
    purgedSessions = purged.deleted;
    failedSessions = purged.failed.length;
  }

  try {
    await deps.host.hostDeleteProfile(slug);
  } catch (error) {
    throw hostDeleteError(error);
  }
  let after: HermesProfileInventory;
  try {
    after = await withDeadline(deps.host.hostProfileInventory(), timeoutMs);
  } catch (error) {
    throw hostDeleteError(error);
  }
  if (after.profiles.some((profile) => profile.name === slug)) {
    throw new ProfileDeleteError(
      502,
      "PROFILE_UNVERIFIED",
      "L’hôte n’a pas confirmé la suppression de ce profil. Aucune ligne n’a été effacée chez openedbot.",
    );
  }

  if (botId) {
    await withTenant(db, organizationId, async (tx) => {
      await deleteBotAfterHostProfileDelete(tx, organizationId, botId);
    });
  }

  return { slug, hostDeleted: true, botId, purgedSessions, failedSessions };
}

export function parseDeleteJobSlugs(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("slugs" in body) || !Array.isArray((body as { slugs: unknown }).slugs)) {
    throw new ProfileDeleteError(400, "PROFILE_INVALID", "La liste des profils à supprimer est invalide.");
  }
  const raw = (body as { slugs: unknown[] }).slugs;
  if (raw.length < 1 || raw.length > PROFILE_DELETE_MAX) {
    throw new ProfileDeleteError(400, "PROFILE_INVALID", "La suppression accepte entre 1 et 64 profils.");
  }
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || value === "default" || !PROFILE_SLUG_PATTERN.test(value)) {
      throw new ProfileDeleteError(400, "PROFILE_INVALID", "Ce slug de profil n’est pas valide.");
    }
    if (seen.has(value)) continue;
    seen.add(value);
    slugs.push(value);
  }
  if (slugs.length === 0) {
    throw new ProfileDeleteError(400, "PROFILE_INVALID", "La liste des profils à supprimer est invalide.");
  }
  return slugs;
}

function botRuntimeSessionIds(
  organizationId: string,
  botId: string,
  scope: {
    threads: ReadonlyArray<{ sessionId: string; threadId: string; sessionGeneration?: number | null }>;
    workflows: ReadonlyArray<{ workflowId: string }>;
  },
): string[] {
  const ids = new Set<string>();
  for (const thread of scope.threads) {
    for (const key of threadSessionKeys(thread.sessionId, Number(thread.sessionGeneration ?? 0))) ids.add(key);
    ids.add(compactionSessionKey(organizationId, thread.threadId));
  }
  for (const workflow of scope.workflows) {
    ids.add(workflowSessionKey(organizationId, workflow.workflowId, botId));
  }
  ids.add(personaDraftSessionKey(organizationId, botId));
  return [...ids];
}

async function purgeRuntimeSessions(
  client: Pick<HermesClient, "deleteSession">,
  sessions: ReadonlyArray<string>,
): Promise<{ deleted: number; failed: string[]; reason: string | null }> {
  let deleted = 0;
  const failed: string[] = [];
  let reason: string | null = null;
  for (const sessionId of sessions) {
    try {
      await client.deleteSession(sessionId);
      deleted += 1;
    } catch (error) {
      failed.push(sessionId);
      reason ??= error instanceof HermesClientError
        ? `Hermes a refusé d’effacer une session de ce bot : ${error.message}`
        : "Une session de ce bot n’a pas pu être effacée sur le runtime.";
    }
  }
  return { deleted, failed, reason };
}

async function assertLinkedBotDeletable(tx: TransactionSQL, organizationId: string, botId: string): Promise<void> {
  const active = await lockActiveBotRuns(tx, organizationId, botId);
  const bots = await tx<Array<{ id: string }>>`
    select id from bots where organization_id = ${organizationId} and id = ${botId}
     for update
  `;
  if (!bots[0]) return;
  await cancelMaintenanceRunsTx(
    tx,
    organizationId,
    active.filter((run) => isMaintenanceStepKind(run.stepKind)),
    {
      code: "CANCELLED_BY_DELETE",
      message: "Passe de maintenance annulée : le bot est supprimé.",
    },
  );
  const blocking = active.find((run) => !isMaintenanceStepKind(run.stepKind))
    ?? (await readActiveBotRuns(tx, organizationId, botId))[0];
  if (blocking) {
    throw new HttpError(
      409,
      "BOT_BUSY",
      "Ce bot exécute encore une mission. Arrêtez-la avant de supprimer le bot.",
      {},
      { runId: blocking.id, stepKind: blocking.stepKind ?? null },
    );
  }
  const memberships = await tx<Array<{ groupId: string }>>`
    select membership.group_id as "groupId"
      from group_members membership
     where membership.organization_id = ${organizationId} and membership.bot_id = ${botId}
     order by membership.group_id limit 1
  `;
  if (memberships[0]) {
    throw new HttpError(
      409,
      "BOT_IN_GROUP",
      "Retirez ce bot de ses salons ou choisissez un autre pilote avant de l’archiver ou de le supprimer.",
    );
  }
  const ingress = await tx<Array<{ id: string }>>`
    select ingress.id from message_ingress ingress
    join threads thread on thread.organization_id = ingress.organization_id and thread.id = ingress.thread_id
     where ingress.organization_id = ${organizationId} and thread.bot_id = ${botId}
       and ingress.state in ('reserved','abandoned')
     limit 1 for update of ingress
  `;
  if (ingress[0]) {
    throw new HttpError(409, "BOT_SUBMISSION_IN_PROGRESS", "Un message idempotent est encore en cours ou en quarantaine.");
  }
}

function lockActiveBotRuns(tx: TransactionSQL, organizationId: string, botId: string): Promise<ActiveBotRun[]> {
  return tx<ActiveBotRun[]>`
    select r.id, r.step_kind as "stepKind", r.thread_id as "threadId" from runs r
    join threads t on t.organization_id = r.organization_id and t.id = r.thread_id
     where r.organization_id = ${organizationId}
       and (r.bot_id = ${botId} or r.caller_bot_id = ${botId}
         or r.handoff_target_bot_id = ${botId} or t.bot_id = ${botId}
         or (t.group_id is not null and exists (
           select 1 from group_members member where member.organization_id = r.organization_id
             and member.group_id = t.group_id and member.bot_id = ${botId}
         )))
       and r.status in ('queued','starting','running','awaiting_approval','relaying','unknown')
     order by r.id for update of r
  `;
}

function readActiveBotRuns(tx: TransactionSQL, organizationId: string, botId: string): Promise<ActiveBotRun[]> {
  return tx<ActiveBotRun[]>`
    select r.id, r.step_kind as "stepKind", r.thread_id as "threadId" from runs r
    join threads t on t.organization_id = r.organization_id and t.id = r.thread_id
     where r.organization_id = ${organizationId}
       and (r.bot_id = ${botId} or r.caller_bot_id = ${botId}
         or r.handoff_target_bot_id = ${botId} or t.bot_id = ${botId}
         or (t.group_id is not null and exists (
           select 1 from group_members member where member.organization_id = r.organization_id
             and member.group_id = t.group_id and member.bot_id = ${botId}
         )))
       and r.status in ('queued','starting','running','awaiting_approval','relaying','unknown')
       and (r.step_kind is null or r.step_kind not in ('memory', 'compaction'))
     order by r.id limit 1
  `;
}

function hostDeleteError(error: unknown): unknown {
  if (error instanceof ProfileDeleteError || error instanceof HttpError) return error;
  if (error instanceof InventoryTimeoutError) {
    return new ProfileDeleteError(502, "HERMES_HOST_TIMEOUT", "L’hôte n’a pas répondu à temps. Aucun changement n’a été supposé.");
  }
  return error;
}

class InventoryTimeoutError extends Error {
  constructor() {
    super("host inventory timed out");
    this.name = "InventoryTimeoutError";
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new InventoryTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export { InventoryTimeoutError };
