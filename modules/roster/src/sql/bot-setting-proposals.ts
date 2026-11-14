import type { BotSettingProposalDto, BotSettingProposalFields, BotSettingProposalStatus } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";

export type BotSettingsTarget = {
  id: string;
  instructions: string;
  label: string | null;
  replyLanguage: string;
  notifyOnFinish: boolean;
  updatedAt: string;
};

export type BotSettingProposalRow = {
  id: string;
  botId: string;
  runId: string;
  threadId: string;
  reason: string | null;
  current: BotSettingProposalFields;
  proposed: BotSettingProposalFields;
  hash: string;
  baseUpdatedAt: string;
  status: BotSettingProposalStatus;
  createdAt: Date | string;
  resolvedAt: Date | string | null;
};

export async function lockBotSettingsTarget(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<BotSettingsTarget | null> {
  const rows = await tx<BotSettingsTarget[]>`
    select id, instructions, label, reply_language as "replyLanguage", notify_on_finish as "notifyOnFinish",
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      from bots
     where organization_id = ${organizationId} and id = ${botId}
     for update
  `;
  return rows[0] ?? null;
}

export async function readBotSettingsTarget(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<BotSettingsTarget | null> {
  const rows = await tx<BotSettingsTarget[]>`
    select id, instructions, label, reply_language as "replyLanguage", notify_on_finish as "notifyOnFinish",
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      from bots
     where organization_id = ${organizationId} and id = ${botId}
  `;
  return rows[0] ?? null;
}

export async function supersedePendingBotSettingProposals(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<void> {
  await tx`
    update bot_setting_proposals
       set status = 'superseded', resolved_at = now()
     where organization_id = ${organizationId} and bot_id = ${botId} and status = 'pending'
  `;
}

export async function insertBotSettingProposal(
  tx: TransactionDb,
  input: {
    organizationId: string;
    botId: string;
    runId: string;
    threadId: string;
    reason: string;
    current: BotSettingProposalFields;
    proposed: BotSettingProposalFields;
    hash: string;
    baseUpdatedAt: string;
  },
): Promise<BotSettingProposalRow> {
  const rows = await tx<BotSettingProposalRow[]>`
    insert into bot_setting_proposals (
      id, organization_id, bot_id, run_id, thread_id, reason, current, proposed, hash, base_updated_at
    ) values (
      ${crypto.randomUUID()}, ${input.organizationId}, ${input.botId}, ${input.runId}, ${input.threadId},
      ${input.reason}, ${JSON.stringify(input.current)}::text::jsonb, ${JSON.stringify(input.proposed)}::text::jsonb,
      ${input.hash}, ${input.baseUpdatedAt}::timestamptz
    )
    returning id, bot_id as "botId", run_id as "runId", thread_id as "threadId", reason,
           current, proposed, hash,
           to_char(base_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "baseUpdatedAt",
           status, created_at as "createdAt", resolved_at as "resolvedAt"
  `;
  return rows[0]!;
}

export async function listThreadBotSettingProposals(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
): Promise<BotSettingProposalDto[]> {
  const rows = await tx<BotSettingProposalRow[]>`
    select id, bot_id as "botId", run_id as "runId", thread_id as "threadId", reason,
           current, proposed, hash,
           to_char(base_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "baseUpdatedAt",
           status, created_at as "createdAt", resolved_at as "resolvedAt" from bot_setting_proposals
     where organization_id = ${organizationId} and thread_id = ${threadId}
     order by created_at asc, id asc
  `;
  return rows.map(toBotSettingProposalDto);
}

export async function lockBotSettingProposal(
  tx: TransactionDb,
  organizationId: string,
  proposalId: string,
  botId: string,
): Promise<BotSettingProposalRow | null> {
  const rows = await tx<BotSettingProposalRow[]>`
    select id, bot_id as "botId", run_id as "runId", thread_id as "threadId", reason,
           current, proposed, hash,
           to_char(base_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "baseUpdatedAt",
           status, created_at as "createdAt", resolved_at as "resolvedAt" from bot_setting_proposals
     where organization_id = ${organizationId} and id = ${proposalId} and bot_id = ${botId}
     for update
  `;
  return rows[0] ?? null;
}

export async function updateBotSettingFields(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  fields: Pick<BotSettingProposalFields, "label" | "replyLanguage" | "notifyOnFinish">,
): Promise<boolean> {
  const hasLabel = Object.hasOwn(fields, "label");
  const hasReplyLanguage = Object.hasOwn(fields, "replyLanguage");
  const hasNotifyOnFinish = Object.hasOwn(fields, "notifyOnFinish");
  const rows = await tx<Array<{ id: string }>>`
    update bots set
      label = case when ${hasLabel} then ${fields.label ?? null} else label end,
      reply_language = case when ${hasReplyLanguage} then ${fields.replyLanguage ?? null} else reply_language end,
      notify_on_finish = case when ${hasNotifyOnFinish} then ${fields.notifyOnFinish ?? null} else notify_on_finish end,
      updated_at = now()
     where organization_id = ${organizationId} and id = ${botId}
    returning id
  `;
  return Boolean(rows[0]);
}

export async function resolveBotSettingProposal(
  tx: TransactionDb,
  organizationId: string,
  proposalId: string,
  status: Exclude<BotSettingProposalStatus, "pending" | "superseded">,
  userId: string,
): Promise<BotSettingProposalRow | null> {
  const rows = await tx<BotSettingProposalRow[]>`
    update bot_setting_proposals
       set status = ${status}, resolved_by = ${userId}, resolved_at = now()
     where organization_id = ${organizationId} and id = ${proposalId} and status = 'pending'
    returning id, bot_id as "botId", run_id as "runId", thread_id as "threadId", reason,
           current, proposed, hash,
           to_char(base_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "baseUpdatedAt",
           status, created_at as "createdAt", resolved_at as "resolvedAt"
  `;
  return rows[0] ?? null;
}

export function toBotSettingProposalDto(row: BotSettingProposalRow): BotSettingProposalDto {
  return {
    id: row.id,
    botId: row.botId,
    runId: row.runId,
    threadId: row.threadId,
    status: row.status,
    reason: row.reason,
    current: row.current,
    proposed: row.proposed,
    hash: row.hash,
    createdAt: new Date(row.createdAt).toISOString(),
    resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
  };
}

