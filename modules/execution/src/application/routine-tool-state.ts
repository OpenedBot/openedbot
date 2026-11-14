import { isUuid } from "@openedbot/contracts-primitives";
import type { TransactionDb } from "@openedbot/platform-db";
import type { RoutineGateTarget } from "../domain/routine-gate";

/**
 * Reads of `routine_manage`'s tables (0187) for the MCP route and the API's
 * installer, under the caller's tenant transaction.
 */

export type RoutineToolBotState = {
  id: string;
  slug: string;
  profile: string | null;
  /** In the trash, or its host profile being deleted: never written to, its proofs void. */
  retired: boolean;
  /** `bot_profile_provisions.status`; `null` for a bot created before provisioning was queued. */
  provision: string | null;
  switchedOff: boolean;
  runtimeId: string | null;
  enabledAt: Date | null;
  disabledAt: Date | null;
  readyAt: Date | null;
  restartPendingSince: Date | null;
  blockedReason: string | null;
  nextAttemptAt: Date | null;
};

/** Every bot of the organization (or one) that is not purged, with its install state. */
export async function readRoutineToolBots(tx: TransactionDb, organizationId: string, botId: string | null): Promise<RoutineToolBotState[]> {
  return tx<RoutineToolBotState[]>`
    select b.id, b.slug, b.hermes_profile as profile, p.status as provision,
           (b.archived_at is not null or b.host_profile_deleting_at is not null) as retired,
           coalesce(t.switched_off, false) as "switchedOff", t.runtime_id as "runtimeId",
           t.enabled_at as "enabledAt", t.disabled_at as "disabledAt", t.ready_at as "readyAt",
           t.restart_pending_since as "restartPendingSince", t.blocked_reason as "blockedReason",
           t.next_attempt_at as "nextAttemptAt"
      from bots b
      left join bot_profile_provisions p on p.organization_id = b.organization_id and p.bot_id = b.id
      left join bot_routine_tools t on t.organization_id = b.organization_id and t.bot_id = b.id
     where b.organization_id = ${organizationId} and b.deleted_at is null
       and (${botId}::uuid is null or b.id = ${botId}::uuid)
     order by b.id
  `;
}

/** The earliest backoff still running in the organization, in ms; `null` when none. */
export async function routineToolNextRetryMs(tx: TransactionDb, organizationId: string): Promise<number | null> {
  const rows = await tx<Array<{ ms: number | null }>>`
    select (extract(epoch from min(next_attempt_at) - now()) * 1000)::float8 as ms
      from bot_routine_tools
     where organization_id = ${organizationId} and next_attempt_at > now()
  `;
  return rows[0]?.ms ?? null;
}

export type RoutineToolServerState = {
  /** The root server was confirmed on the host with the stored secret. */
  installed: boolean;
  /** Root writes the host did not confirm in a row, and the link session they happened in. */
  rootFailures: number;
  rootFailedLinkAt: Date | null;
  /** The runtime's current link session: a reconnection lifts a root pause. */
  linkConnectedAt: Date | null;
  verifiedAt: Date | null;
  authFailedAt: Date | null;
};

export async function readRoutineToolServer(tx: TransactionDb, organizationId: string, runtimeId: string): Promise<RoutineToolServerState> {
  const rows = await tx<RoutineToolServerState[]>`
    select coalesce(r.installed_at is not null, false) as installed,
           coalesce(r.root_failures, 0) as "rootFailures", r.root_failed_link_at as "rootFailedLinkAt",
           rt.link_connected_at as "linkConnectedAt", r.verified_at as "verifiedAt", r.auth_failed_at as "authFailedAt"
      from runtimes rt
      left join runtime_routine_tools r on r.organization_id = rt.organization_id and r.runtime_id = rt.id
     where rt.organization_id = ${organizationId} and rt.id = ${runtimeId}
  `;
  return rows[0] ?? { installed: false, rootFailures: 0, rootFailedLinkAt: null, linkConnectedAt: null, verifiedAt: null, authFailedAt: null };
}

/**
 * Where the calling bot stands: switched off by the operator, or usable,
 * which needs the tool proven on its profile on the runtime whose bearer
 * called (the secret of another runtime proves nothing here).
 */
export async function routineToolCallerState(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  runtimeId: string,
): Promise<{ switchedOff: boolean; usable: boolean }> {
  const rows = await tx<Array<{ switchedOff: boolean; usable: boolean }>>`
    select switched_off as "switchedOff", (enabled_at is not null and runtime_id = ${runtimeId}) as usable
      from bot_routine_tools where organization_id = ${organizationId} and bot_id = ${botId}
  `;
  return rows[0] ?? { switchedOff: false, usable: false };
}

/**
 * The routines `routine_manage` approval gates point to (`job_id`), each among
 * its run's bot's own routines only, keyed `<botId>:<routineId>`: their
 * current name and whether they run without waiting for a person. A
 * `job_id` that is not a uuid names nothing.
 */
export async function readRoutineGateTargets(
  tx: TransactionDb,
  organizationId: string,
  refs: ReadonlyArray<{ botId: string | null; jobId: string }>,
): Promise<Map<string, RoutineGateTarget>> {
  const ids = [...new Set(refs.filter((ref) => ref.botId !== null && isUuid(ref.jobId)).map((ref) => ref.jobId.toLowerCase()))];
  if (ids.length === 0) return new Map();
  const rows = await tx<Array<{ id: string; botId: string; name: string; neverWait: boolean }>>`
    select id, bot_id as "botId", name, never_wait as "neverWait" from routines
     where organization_id = ${organizationId} and id = any(${tx.array(ids, "UUID")}::uuid[])
  `;
  return new Map(rows.map((row) => [`${row.botId}:${row.id}`, { name: row.name, neverWait: row.neverWait }]));
}
