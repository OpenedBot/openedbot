import type { SQL } from "bun";
import type { TransactionDb } from "@openedbot/platform-db";
import type { YoloLease, YoloLeaseHostState, YoloScope } from "@openedbot/contracts-api";

/**
 * Mode YOLO (migration 0158) : baux, consentements et audit. Toute écriture
 * d'un bail passe par `grant_permission_yolo_lease` et
 * `revoke_permission_yolo_leases`, qui vérifient owner/admin et le tenant ;
 * chaque lecture filtre l'organisation explicitement, sous le tenant lié.
 */

export type YoloLeaseRow = {
  id: string;
  scope: YoloScope;
  runtimeId: string;
  botId: string | null;
  threadId: string | null;
  grantedByUserId: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  hostState: YoloLeaseHostState;
  deliveredAt: Date | null;
};

/** Ce que la charge d'un bail cible : le runtime, le profil du bot, la session du thread. */
export type YoloTargetRow = {
  runtimeId: string | null;
  botProfile: string | null;
  botFound: boolean;
  threadSessionId: string | null;
  threadFound: boolean;
};

/**
 * Le runtime (celui demandé, ou l'actif de l'organisation), le profil Hermes
 * du bot vivant et la session Hermes du thread de ce bot. La fonction
 * d'octroi revérifie chacun sous le verrou de l'organisation.
 */
export async function readYoloTargetTx(
  tx: TransactionDb,
  organizationId: string,
  target: { runtimeId: string | null; botId: string | null; threadId: string | null },
): Promise<YoloTargetRow> {
  const runtimes = target.runtimeId
    ? await tx<Array<{ id: string }>>`
        select id from runtimes where organization_id = ${organizationId} and id = ${target.runtimeId} and revoked_at is null`
    : await tx<Array<{ id: string }>>`
        select id from runtimes where organization_id = ${organizationId} and is_active and revoked_at is null`;
  const bots = target.botId
    ? await tx<Array<{ profile: string | null }>>`
        select hermes_profile as profile from bots
         where organization_id = ${organizationId} and id = ${target.botId} and archived_at is null`
    : [];
  const threads = target.threadId && target.botId
    ? await tx<Array<{ sessionId: string }>>`
        select hermes_session_id as "sessionId" from threads
         where organization_id = ${organizationId} and id = ${target.threadId} and bot_id = ${target.botId}`
    : [];
  return {
    runtimeId: runtimes[0]?.id ?? null,
    botFound: bots.length > 0,
    botProfile: bots[0]?.profile ?? null,
    threadFound: threads.length > 0,
    threadSessionId: threads[0]?.sessionId ?? null,
  };
}

export type YoloGrantStatus =
  | "granted"
  | "blocked_ceiling"
  | "blocked_enforce_review"
  | "policy_changed"
  | "runtime_not_found"
  | "host_unsupported"
  | "host_unsupported_thread"
  | "target_not_found"
  | "bot_profile_missing"
  | "target_changed"
  | "ack_required";

export async function grantYoloLeaseTx(
  tx: TransactionDb,
  input: {
    organizationId: string;
    actorUserId: string;
    botId: string | null;
    threadId: string | null;
    keyId: string;
    signature: string;
    lease: YoloLease;
    acknowledged: boolean;
  },
): Promise<{ status: YoloGrantStatus; superseded: string[] }> {
  const rows = await tx<Array<{ status: YoloGrantStatus; superseded: string[] | null }>>`
    select status, superseded::text[] as superseded from grant_permission_yolo_lease(
      ${input.organizationId}::uuid, ${input.actorUserId}::uuid, ${input.botId}::uuid, ${input.threadId}::uuid,
      ${input.keyId}, ${input.signature}, ${JSON.stringify(input.lease)}::text::jsonb, ${input.acknowledged}
    )
  `;
  const row = rows[0];
  if (!row) throw new Error("grant_permission_yolo_lease returned no row");
  return { status: row.status, superseded: row.superseded ?? [] };
}

/** Révoque un bail (`leaseId`) ou tous ceux de l'organisation (`null`, kill switch). Rend ceux révoqués à l'instant. */
export async function revokeYoloLeasesTx(
  tx: TransactionDb,
  input: { organizationId: string; actorUserId: string; leaseId: string | null; reason: "manual" | "kill_switch" },
): Promise<Array<{ leaseId: string; runtimeId: string }>> {
  return tx<Array<{ leaseId: string; runtimeId: string }>>`
    select lease_id as "leaseId", runtime_id as "runtimeId" from revoke_permission_yolo_leases(
      ${input.organizationId}::uuid, ${input.actorUserId}::uuid, ${input.leaseId}::uuid, ${input.reason}
    )
  `;
}

export async function readYoloLeaseTx(tx: TransactionDb, organizationId: string, leaseId: string): Promise<YoloLeaseRow | null> {
  const rows = await tx<YoloLeaseRow[]>`
    select id, scope, runtime_id as "runtimeId", bot_id as "botId", thread_id as "threadId",
           granted_by_user_id as "grantedByUserId", issued_at as "issuedAt", expires_at as "expiresAt",
           revoked_at as "revokedAt", host_state as "hostState", delivered_at as "deliveredAt"
      from permission_yolo_leases where organization_id = ${organizationId} and id = ${leaseId}
  `;
  return rows[0] ?? null;
}

/** Les baux vivants (non révoqués, pas encore échus), filtrés par cible ; les plus récents d'abord. */
export async function readLiveYoloLeasesTx(
  tx: TransactionDb,
  organizationId: string,
  filters: { runtimeId?: string; botId?: string; threadId?: string } = {},
): Promise<YoloLeaseRow[]> {
  const runtimeId = filters.runtimeId ?? null;
  const botId = filters.botId ?? null;
  const threadId = filters.threadId ?? null;
  return tx<YoloLeaseRow[]>`
    select id, scope, runtime_id as "runtimeId", bot_id as "botId", thread_id as "threadId",
           granted_by_user_id as "grantedByUserId", issued_at as "issuedAt", expires_at as "expiresAt",
           revoked_at as "revokedAt", host_state as "hostState", delivered_at as "deliveredAt"
      from permission_yolo_leases
     where organization_id = ${organizationId} and revoked_at is null and expires_at > now()
       and (${runtimeId}::uuid is null or runtime_id = ${runtimeId}::uuid)
       and (${botId}::uuid is null or bot_id = ${botId}::uuid or scope = 'runtime')
       and (${threadId}::uuid is null or thread_id = ${threadId}::uuid or scope <> 'thread')
     order by issued_at desc, id
     limit 200
  `;
}

/**
 * Le bail qui couvre une porte, du plus précis au plus large (thread, bot,
 * runtime), dans sa fenêtre selon l'horloge de la base. `payload` est la
 * charge signée : la porte en relit deny-list et protections.
 */
export async function readGateYoloLeaseTx(
  tx: SQL,
  query: { organizationId: string; runtimeId: string; botId: string; threadId: string | null },
): Promise<{ id: string; payload: unknown } | null> {
  const rows = await tx<Array<{ id: string; payload: unknown }>>`
    select id, payload from permission_yolo_leases
     where organization_id = ${query.organizationId} and runtime_id = ${query.runtimeId}
       and revoked_at is null and not_before <= now() and expires_at > now()
       and (scope = 'runtime'
         or (scope = 'bot' and bot_id = ${query.botId})
         or (scope = 'thread' and bot_id = ${query.botId} and thread_id = ${query.threadId}))
     order by case scope when 'thread' then 0 when 'bot' then 1 else 2 end
     limit 1
  `;
  return rows[0] ?? null;
}

/**
 * Les baux vivants qui couvrent un bot entier (portée bot ou runtime) sur le
 * runtime actif, où tournent les bots : l'état effectif de la fiche. Un bail
 * de thread se lit avec `readLiveYoloLeasesTx`.
 */
export async function readBotCoverYoloLeasesTx(
  tx: TransactionDb,
  organizationId: string,
): Promise<Array<{ id: string; scope: "bot" | "runtime"; botId: string | null; expiresAt: Date }>> {
  return tx<Array<{ id: string; scope: "bot" | "runtime"; botId: string | null; expiresAt: Date }>>`
    select l.id, l.scope, l.bot_id as "botId", l.expires_at as "expiresAt"
      from permission_yolo_leases l
      join runtimes r on r.organization_id = l.organization_id and r.id = l.runtime_id
     where l.organization_id = ${organizationId} and r.is_active and r.revoked_at is null
       and l.scope in ('bot', 'runtime') and l.revoked_at is null
       and l.not_before <= now() and l.expires_at > now()
  `;
}

/** Les runtimes non révoqués de l'organisation : chacun reçoit le kill switch. */
export async function readLiveRuntimeIdsTx(tx: TransactionDb, organizationId: string): Promise<string[]> {
  const rows = await tx<Array<{ id: string }>>`
    select id from runtimes where organization_id = ${organizationId} and revoked_at is null
  `;
  return rows.map((row) => row.id);
}

export type YoloConsentRow ={ acknowledgedAt: Date; soloDefault: boolean };

export async function readYoloConsentTx(tx: TransactionDb, organizationId: string, userId: string): Promise<YoloConsentRow | null> {
  const rows = await tx<YoloConsentRow[]>`
    select acknowledged_at as "acknowledgedAt", solo_default as "soloDefault" from permission_yolo_consents
     where organization_id = ${organizationId} and user_id = ${userId}
  `;
  return rows[0] ?? null;
}

/** `soloDefault` absent : la valeur enregistrée est gardée. */
export async function writeYoloConsentTx(
  tx: TransactionDb,
  input: { organizationId: string; userId: string; soloDefault: boolean | null },
): Promise<YoloConsentRow> {
  const rows = await tx<YoloConsentRow[]>`
    insert into permission_yolo_consents (organization_id, user_id, solo_default)
    values (${input.organizationId}, ${input.userId}, ${input.soloDefault ?? false})
    on conflict (organization_id, user_id) do update
      set acknowledged_at = now(), updated_at = now(),
          solo_default = coalesce(${input.soloDefault}::boolean, permission_yolo_consents.solo_default)
    returning acknowledged_at as "acknowledgedAt", solo_default as "soloDefault"
  `;
  return rows[0]!;
}

export type YoloAuditRow = {
  id: string;
  runtimeId: string;
  leaseId: string;
  writeSeq: string;
  occurredAt: Date;
  profile: string;
  gateKind: string;
  toolKey: string | null;
  argsHash: string;
  entryHash: string;
};

/** Une page de l'audit, les plus récentes d'abord ; `before` : l'`id` de la dernière ligne de la page précédente. */
export async function readYoloAuditTx(
  tx: TransactionDb,
  organizationId: string,
  query: { leaseId: string | null; before: string | null; limit: number },
): Promise<YoloAuditRow[]> {
  return tx<YoloAuditRow[]>`
    select id::text as id, runtime_id as "runtimeId", lease_id as "leaseId", write_seq::text as "writeSeq",
           occurred_at as "occurredAt", profile, gate_kind as "gateKind", tool_key as "toolKey",
           args_hash as "argsHash", entry_hash as "entryHash"
      from permission_yolo_audit
     where organization_id = ${organizationId}
       and (${query.leaseId}::uuid is null or lease_id = ${query.leaseId}::uuid)
       and (${query.before}::bigint is null or id < ${query.before}::bigint)
     order by id desc
     limit ${query.limit}
  `;
}
