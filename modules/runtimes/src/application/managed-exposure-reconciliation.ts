import type { SQL } from "bun";
import { CloudflareApiError, createCloudflareApiClient, type CloudflareApiClient } from "@openedbot/platform-integrations/cloudflare-api";
import type { ManagedTunnelConfig } from "@openedbot/platform-integrations/managed-tunnel";
import { deprovisionDirectExposure } from "./direct-exposure-provisioning";

export const MANAGED_EXPOSURE_TICK_MS = 5 * 60_000;

type ManagedExposureRow = { id: string; organizationId: string; accountId: string; tunnelId: string };

/**
 * Relit chez Cloudflare l'état des tunnels gérés par openedbot, un par
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

type RevokedManagedExposureRow = {
  id: string;
  organizationId: string;
  accountId: string;
  zoneId: string;
  tunnelId: string | null;
  dnsRecordId: string | null;
  accessAppId: string | null;
  serviceTokenId: string | null;
};

/**
 * Reprend le retrait chez Cloudflare des tunnels gérés révoqués dont le
 * nettoyage n'a pas abouti après le commit de la révocation
 * (`cleanup_status = 'pending'`, 0171). Une ligne par transaction sous verrou,
 * au plus une tentative par tick et par ligne ; les suppressions tolèrent un
 * 404, donc une reprise rejoue tout sans risque. Un code borné en cas d'échec.
 */
export async function cleanupRevokedManagedExposures(
  db: SQL,
  managed: ManagedTunnelConfig | null,
  client: CloudflareApiClient | null = managed ? createCloudflareApiClient(managed.apiToken) : null,
  signal?: AbortSignal,
): Promise<number> {
  if (!managed || !client) return 0;
  const dueBefore = new Date(Date.now() - MANAGED_EXPOSURE_TICK_MS);
  let count = 0;
  while (!signal?.aborted && await db.begin(async (tx) => {
    const rows = await tx<RevokedManagedExposureRow[]>`
      select id, organization_id as "organizationId", cloudflare_account_id as "accountId", zone_id as "zoneId",
             tunnel_id as "tunnelId", dns_record_id as "dnsRecordId", access_app_id as "accessAppId",
             service_token_id as "serviceTokenId"
        from runtime_direct_exposures
       where kind = 'managed_cloudflare' and status = 'revoked' and cleanup_status = 'pending'
         and cloudflare_account_id is not null and zone_id is not null
         and (last_checked_at is null or last_checked_at <= ${dueBefore})
       order by last_checked_at asc nulls first
       limit 1 for update skip locked`;
    const row = rows[0];
    if (!row) return 0;
    let errorCode: string | null = null;
    try {
      await deprovisionDirectExposure(client, row);
    } catch (error) {
      errorCode = error instanceof CloudflareApiError ? error.code : "CLOUDFLARE_UNAVAILABLE";
    }
    await tx`
      update runtime_direct_exposures
         set cleanup_status = case when ${errorCode}::text is null then 'done' else cleanup_status end,
             error_code = ${errorCode}, last_checked_at = now(), updated_at = now()
       where id = ${row.id} and organization_id = ${row.organizationId}`;
    return 1;
  })) count++;
  return count;
}
