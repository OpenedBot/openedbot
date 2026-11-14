import type { TransactionDb } from "@openedbot/platform-db";
export async function rememberWorkspaceActivation(
  tx: TransactionDb,
  organizationId: string,
  facts: { machine: boolean; model: boolean; bot: boolean; result: boolean },
) {
  const rows = await tx<
    Array<{ machine: boolean; model: boolean; bot: boolean; result: boolean }>
  >`
    insert into workspace_activation(organization_id,machine,model,bot,result)
      values(${organizationId},${facts.machine},${facts.model},${facts.bot},${facts.result})
      on conflict(organization_id) do update set machine=workspace_activation.machine or excluded.machine,
        model=workspace_activation.model or excluded.model,bot=workspace_activation.bot or excluded.bot,result=workspace_activation.result or excluded.result
      returning machine,model,bot,result`;
  return rows[0]!;
}
