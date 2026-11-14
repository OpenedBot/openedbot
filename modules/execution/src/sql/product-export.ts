import type { TransactionDb } from "@openedbot/platform-db";
export function selectBotRoutineExports(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
) {
  return tx`select name,schedule,timezone,message,enabled from routines where organization_id=${organizationId} and bot_id=${botId} order by created_at`;
}
export async function readResultActivation(
  tx: TransactionDb,
  organizationId: string,
): Promise<boolean> {
  const rows = await tx<Array<{ result: boolean }>>`select exists(
    select 1 from workflows w join runs r on r.organization_id=w.organization_id and r.id=w.root_run_id
    where w.organization_id=${organizationId} and w.status='completed' and w.kind<>'routine' and r.origin is null
      and w.initiator_user_id is not null and length(trim(coalesce(w.final_output,r.output)))>0) as result`;
  return rows[0]!.result;
}
