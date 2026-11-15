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
