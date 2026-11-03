import type { SQL } from "bun";
import type { PermissionRuleKind } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";
import { underTenant, type ToolPolicyActor } from "./tool-policies";

type Queryable = SQL | TransactionDb;

/**
 * PERM2-6 (migration 0145): natural-language permission rules. `botId`
 * null is the organization scope. Every query filters on the organization
 * explicitly, the API's tenant policy and the worker's alike.
 */
export type PermissionRuleRow = {
  id: string;
  botId: string | null;
  kind: string;
  text: string;
  createdAt: Date;
  createdByKind: "member" | "agency";
};

type RawRow = Omit<PermissionRuleRow, "createdAt"> & { createdAt: Date | string };

const toRow = (row: RawRow): PermissionRuleRow => ({ ...row, createdAt: new Date(row.createdAt) });

/** The rules of one scope, oldest first in each kind. Runs under the API tenant. */
export async function listPermissionRules(tx: TransactionDb, organizationId: string, botId: string | null): Promise<PermissionRuleRow[]> {
  const rows = botId === null
    ? await tx<RawRow[]>`
      select id, bot_id as "botId", kind, text, created_at as "createdAt", created_by_kind as "createdByKind"
        from bot_permission_rules
       where organization_id = ${organizationId} and bot_id is null
       order by kind, created_at, id
    `
    : await tx<RawRow[]>`
      select id, bot_id as "botId", kind, text, created_at as "createdAt", created_by_kind as "createdByKind"
        from bot_permission_rules
       where organization_id = ${organizationId} and bot_id = ${botId}
       order by kind, created_at, id
    `;
  return rows.map(toRow);
}

export async function countPermissionRules(tx: TransactionDb, organizationId: string, botId: string | null, kind: PermissionRuleKind): Promise<number> {
  const rows = await tx<Array<{ count: number | string }>>`
    select count(*) as count from bot_permission_rules
     where organization_id = ${organizationId} and bot_id is not distinct from ${botId}::uuid and kind = ${kind}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** A rule of the same scope with the same text, case ignored, whatever its kind. */
export async function hasPermissionRuleText(tx: TransactionDb, organizationId: string, botId: string | null, text: string): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    select id from bot_permission_rules
     where organization_id = ${organizationId} and bot_id is not distinct from ${botId}::uuid and lower(text) = lower(${text})
     limit 1
  `;
  return rows.length > 0;
}

export async function insertPermissionRule(
  tx: TransactionDb,
  input: { organizationId: string; botId: string | null; kind: PermissionRuleKind; text: string; actor: ToolPolicyActor & { userId: string } },
): Promise<PermissionRuleRow> {
  const rows = await tx<RawRow[]>`
    insert into bot_permission_rules
      (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind, created_by_agency_organization_id)
    values (${input.organizationId}, ${input.botId}, ${input.kind}, ${input.text},
            ${input.actor.userId}, ${input.actor.kind}, ${input.actor.agencyOrganizationId})
    returning id, bot_id as "botId", kind, text, created_at as "createdAt", created_by_kind as "createdByKind"
  `;
  return toRow(rows[0]!);
}

/** `false` when the rule is not in this scope (gone, or another bot's). */
export async function deletePermissionRule(tx: TransactionDb, organizationId: string, botId: string | null, ruleId: string): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    delete from bot_permission_rules
     where organization_id = ${organizationId} and id = ${ruleId} and bot_id is not distinct from ${botId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export type ReviewRuleRow = { scope: "bot" | "organization"; kind: string; text: string };

/**
 * The rules the reviewer may read for one bot: the bot's own and the
 * organization's, oldest first. The worker's policy on the table is tenant
 * scoped (0145): the read sets `app.organization_id` for itself and puts the
 * previous value back. Must run inside a transaction.
 */
export async function readReviewRulesTx(tx: Queryable, organizationId: string, botId: string): Promise<ReviewRuleRow[]> {
  return underTenant(tx, organizationId, async () => tx<ReviewRuleRow[]>`
    select case when bot_id is null then 'organization' else 'bot' end as scope, kind, text
      from bot_permission_rules
     where organization_id = ${organizationId} and (bot_id is null or bot_id = ${botId})
     order by created_at, id
  `);
}
