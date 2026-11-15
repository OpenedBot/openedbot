import type { TransactionDb } from "@openedbot/platform-db";
export function selectBotRoutineExports(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
) {
  return tx`select name,schedule,timezone,message,enabled from routines where organization_id=${organizationId} and bot_id=${botId} order by created_at`;
}
