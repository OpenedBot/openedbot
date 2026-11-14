import type { TransactionDb } from "@openedbot/platform-db";
export async function botAvailableForExport(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<boolean> {
  const rows =
    await tx`select id from bots where organization_id=${organizationId} and id=${botId} and deleted_at is null`;
  return rows.length > 0;
}
export async function selectBotConfigurationExport(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
) {
  const rows =
    await tx`select name,description,instructions,model,reasoning_effort as "reasoningEffort",face,
    autonomy_enabled as "autonomyEnabled",autonomy_max_steps as "maxSteps",autonomy_timeout_seconds as "timeoutSeconds",
    autonomy_token_budget::integer as "tokenBudget",permission_mode as "permissionMode",reply_language as "replyLanguage",
    notify_on_finish as "notifyOnFinish",fast_mode as "fastMode",voice_id as "voiceId"
    from bots where organization_id=${organizationId} and id=${botId} and deleted_at is null`;
  return rows[0] ?? null;
}
export async function readBotActivation(
  tx: TransactionDb,
  organizationId: string,
) {
  const rows = await tx<
    Array<{ bot: boolean; firstBotId: string | null }>
  >`select
    exists(select 1 from bots b left join bot_profile_provisions p on p.organization_id=b.organization_id and p.bot_id=b.id
      where b.organization_id=${organizationId} and b.deleted_at is null and (p.status is null or p.status='succeeded')) as bot,
    (select b.id from bots b left join bot_profile_provisions p on p.organization_id=b.organization_id and p.bot_id=b.id
      where b.organization_id=${organizationId} and b.deleted_at is null and b.archived_at is null and (p.status is null or p.status='succeeded') order by b.created_at limit 1) as "firstBotId"`;
  return rows[0]!;
}
