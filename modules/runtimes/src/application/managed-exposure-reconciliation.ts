import type { SQL } from "bun";
import { CloudflareApiError, createCloudflareApiClient, type CloudflareApiClient } from "@openedbot/platform-integrations/cloudflare-api";
import type { ManagedTunnelConfig } from "@openedbot/platform-integrations/managed-tunnel";

export const MANAGED_EXPOSURE_TICK_MS = 5 * 60_000;

type ManagedExposureRow = { id: string; organizationId: string; accountId: string; tunnelId: string };

/**
 * OHB-75 : relit chez Cloudflare l'état des tunnels gérés par openedbot, un par
 * transaction sous verrou, et écrit `healthy | degraded | down | inactive`.
 * C'est ce qui fait dire « tunnel à terre » dans le registre sans attendre
 * qu'un run échoue. Les publications du compte du client sont hors champ :
 * openedbot n'a aucun token pour les lire.
 *
 * Jamais un message d'erreur Cloudflare en base : un code borné, ou rien.
 */
export async function reconcileManagedExposures(
  db: SQL,
  managed: ManagedTunnelConfig | null,
  client: CloudflareApiClient | null = managed ? createCloudflareApiClient(managed.apiToken) : null,
  signal?: AbortSignal,
): Promise<number> {
  if (!managed || !client) return 0;
  const dueBefore = new Date(Date.now() - MANAGED_EXPOSURE_TICK_MS);
  let count = 0;
  while (!signal?.aborted && await db.begin(async (tx) => {
    const rows = await tx<ManagedExposureRow[]>`
      select id, organization_id as "organizationId", cloudflare_account_id as "accountId", tunnel_id as "tunnelId"
        from runtime_direct_exposures
       where kind = 'managed_cloudflare' and revoked_at is null and tunnel_id is not null
         and status in ('awaiting_install', 'reachable', 'declared')
         and (last_checked_at is null or last_checked_at <= ${dueBefore})
       order by last_checked_at asc nulls first
       limit 1 for update skip locked`;
    const row = rows[0];
    if (!row) return 0;
    let tunnelStatus = "unknown";
    let errorCode: string | null = null;
    try {
      tunnelStatus = (await client.readTunnel(row.accountId, row.tunnelId)).status;
    } catch (error) {
      errorCode = error instanceof CloudflareApiError ? error.code : "CLOUDFLARE_UNAVAILABLE";
    }
    await tx`
      update runtime_direct_exposures
         set last_tunnel_status = ${tunnelStatus}, error_code = ${errorCode},
             status = case when status = 'awaiting_install' and ${tunnelStatus === "healthy"} then 'reachable' else status end,
             last_checked_at = now(), updated_at = now()
       where id = ${row.id} and organization_id = ${row.organizationId}`;
    return 1;
  })) count++;
  return count;
}
