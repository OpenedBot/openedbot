import type { SQL } from "bun";

/**
 * PERM2-4 (0140): "Always for this tool on this bot". The API writes; the
 * worker only reads, tenant-scoped: every query filters `organization_id`
 * explicitly, and the worker's read sets `app.organization_id` first.
 */
export type PermissionActor = {
  userId: string;
  kind: "member" | "agency";
  /** The mandated agency organization, for `agency` only. */
  agencyOrganizationId: string | null;
};

export type BotPermissionGrantRow = {
  id: string;
  toolKey: string;
  createdAt: Date | string;
  createdByKind: "member" | "agency";
  createdByName: string | null;
  createdFromApprovalId: string | null;
  createdFromThreadId: string | null;
};

/** The active grant of this tool on this bot, `null` when none (PERM2-11: the decision records it). */
export async function activeGrantIdTx(tx: SQL, organizationId: string, botId: string, toolKey: string): Promise<string | null> {
  const rows = await tx<Array<{ id: string }>>`
    select id from bot_permission_grants
     where organization_id = ${organizationId} and bot_id = ${botId}
       and tool_key = ${toolKey} and status = 'active'
  `;
  return rows[0]?.id ?? null;
}

/**
 * Creates the active grant, or returns the one already active (a double
 * click, two operators): the partial unique index decides, never a read
 * before the write.
 */
export async function createBotPermissionGrantTx(
  tx: SQL,
  input: { organizationId: string; botId: string; toolKey: string; actor: PermissionActor; approvalId: string | null },
): Promise<{ id: string; created: boolean }> {
  const inserted = await tx<Array<{ id: string }>>`
    insert into bot_permission_grants (
      organization_id, bot_id, tool_key, created_by_user_id, created_by_kind,
      created_by_agency_organization_id, created_from_approval_id
    ) values (
      ${input.organizationId}, ${input.botId}, ${input.toolKey}, ${input.actor.userId}, ${input.actor.kind},
      ${input.actor.agencyOrganizationId}, ${input.approvalId}
    )
    on conflict (organization_id, bot_id, tool_key) where status = 'active' do nothing
    returning id
  `;
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const existing = await tx<Array<{ id: string }>>`
    select id from bot_permission_grants
     where organization_id = ${input.organizationId} and bot_id = ${input.botId}
       and tool_key = ${input.toolKey} and status = 'active'
  `;
  if (!existing[0]) throw new Error("PERMISSION_GRANT_NOT_RECORDED");
  return { id: existing[0].id, created: false };
}

export async function listActiveBotPermissionGrants(tx: SQL, organizationId: string, botId: string): Promise<BotPermissionGrantRow[]> {
  return tx<BotPermissionGrantRow[]>`
    select g.id, g.tool_key as "toolKey", g.created_at as "createdAt", g.created_by_kind as "createdByKind",
           coalesce(nullif(u.display_name, ''), u.email) as "createdByName",
           g.created_from_approval_id as "createdFromApprovalId", a.thread_id as "createdFromThreadId"
      from bot_permission_grants g
      left join users u on u.id = g.created_by_user_id
      left join approval_requests a on a.organization_id = g.organization_id and a.id = g.created_from_approval_id
     where g.organization_id = ${organizationId} and g.bot_id = ${botId} and g.status = 'active'
     order by g.created_at desc, g.id
     limit 200
  `;
}

/** `null`: no active grant of this bot has this id (already revoked, or another bot's). */
export async function revokeBotPermissionGrantTx(
  tx: SQL,
  input: { organizationId: string; botId: string; grantId: string; actor: PermissionActor; reason: string | null },
): Promise<{ id: string } | null> {
  const rows = await tx<Array<{ id: string }>>`
    update bot_permission_grants
       set status = 'revoked', revoked_at = now(), revoked_by_user_id = ${input.actor.userId},
           revoked_by_kind = ${input.actor.kind}, revoked_reason = ${input.reason}
     where organization_id = ${input.organizationId} and bot_id = ${input.botId}
       and id = ${input.grantId} and status = 'active'
    returning id
  `;
  return rows[0] ?? null;
}
