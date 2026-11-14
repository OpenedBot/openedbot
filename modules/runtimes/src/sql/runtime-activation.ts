import type { TransactionDb } from "@openedbot/platform-db";
export async function readRuntimeActivation(
  tx: TransactionDb,
  organizationId: string,
) {
  const rows = await tx<
    Array<{ machine: boolean; model: boolean; machineOnline: boolean }>
  >`select
    exists(select 1 from runtimes where organization_id=${organizationId} and link_last_seen_at is not null) as machine,
    exists(select 1 from runtime_model_proven where organization_id=${organizationId}) as model,
    exists(select 1 from runtimes where organization_id=${organizationId} and is_active and revoked_at is null
      and link_last_seen_at>now()-interval '90 seconds' and last_health_status<>'disconnected') as "machineOnline"`;
  return rows[0]!;
}
