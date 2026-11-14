import { createCloudflareApiClient, type CloudflareApiClient } from "@openedbot/platform-integrations/cloudflare-api";
import { createTailscaleApiClient, type TailscaleApiClient, type TailscaleCredentials } from "@openedbot/platform-integrations/tailscale-api";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
import { withTenant } from "@openedbot/platform-db";
import { readExposureByRuntime, type RuntimeExposureRow } from "../sql/runtime-exposures";
import { deprovisionDirectExposure } from "./direct-exposure-provisioning";
import { deprovisionTailscaleExposure } from "./tailscale-exposure-provisioning";

export type CloudflareClientFactory = (apiToken: string) => CloudflareApiClient;
export type TailscaleClientFactory = (credentials: TailscaleCredentials) => TailscaleApiClient;

export const defaultCloudflareClientFactory: CloudflareClientFactory = (apiToken) => createCloudflareApiClient(apiToken);
export const defaultTailscaleClientFactory: TailscaleClientFactory = (credentials) => createTailscaleApiClient(credentials);

/** Les fabriques que la révocation utilise ; des faux dans les tests. */
export type ExposureClientFactories = {
  cloudflare?: CloudflareClientFactory;
  tailscale?: TailscaleClientFactory;
};

/** Le nettoyage distant qu'une révocation laisse à faire. */
export type ExposureCleanupStatus = "pending" | "manual" | "none";

/**
 * Révoque une exposition dans la transaction métier, SANS appel fournisseur :
 * la transaction peut encore être annulée (remplacement de runtime refusé,
 * fournisseur en panne), et une suppression distante ne se rejoue pas à
 * l'envers. L'état du nettoyage (`cleanup_status`) est écrit avec la
 * révocation : `pending` quand openedbot peut retirer lui-même ce qu'il a posé
 * (token Cloudflare d'openedbot pour un tunnel géré, client OAuth du tailnet
 * fourni par le propriétaire pour une publication Funnel), `manual` quand le
 * retrait reste à faire à la main.
 *
 * Les publications `customer_cloudflare`, qui n'existent plus que dans
 * l'historique, n'ont plus de token pour être nettoyées : elles sont révoquées
 * chez openedbot et laissées à la main sur le compte du client.
 */
export async function markExposureRevoked(
  tx: Bun.TransactionSQL,
  config: ApiConfig,
  row: RuntimeExposureRow,
  tailscaleCredentials: TailscaleCredentials | null,
): Promise<ExposureCleanupStatus> {
  const cleanup = exposureCleanupStatus(config, row, tailscaleCredentials);
  await tx`
    update runtime_direct_exposures
       set status = 'revoked', revoked_at = coalesce(revoked_at, now()), updated_at = now(),
           cleanup_status = ${cleanup === "none" ? null : cleanup},
           install_token_ciphertext = null, install_token_nonce = null, install_token_tag = null, install_token_key_id = null,
           edge_auth_ciphertext = null, edge_auth_nonce = null, edge_auth_tag = null, edge_auth_key_id = null
     where organization_id = ${row.organizationId} and id = ${row.id}`;
  return cleanup;
}

function exposureCleanupStatus(
  config: ApiConfig,
  row: RuntimeExposureRow,
  tailscaleCredentials: TailscaleCredentials | null,
): ExposureCleanupStatus {
  if (row.kind === "tailscale_funnel") {
    if (tailscaleCredentials) return "pending";
    return row.tailscaleAuthKeyId ? "manual" : "none";
  }
  const apiToken = row.kind === "managed_cloudflare" ? config.managedTunnel?.apiToken ?? null : null;
  return apiToken && row.cloudflareAccountId && row.zoneId ? "pending" : "manual";
}

/**
 * Retire chez le fournisseur ce qu'une révocation COMMITÉE a laissé, puis
 * écrit `cleanup_status = 'done'`. Les suppressions sont idempotentes (un 404
 * vaut succès) : un échec laisse `pending`, et la reprise rejoue tout. Le
 * worker reprend seul un tunnel géré ; une publication Funnel se reprend par
 * un nouveau DELETE avec le client OAuth du tailnet. Rend `manual` quand les
 * identifiants nécessaires manquent.
 */
export async function cleanupRevokedExposure(
  db: Bun.SQL,
  config: ApiConfig,
  row: RuntimeExposureRow,
  tailscaleCredentials: TailscaleCredentials | null,
  factories: ExposureClientFactories = {},
): Promise<"done" | "manual"> {
  if (row.kind === "tailscale_funnel") {
    if (!tailscaleCredentials) return "manual";
    const client = (factories.tailscale ?? defaultTailscaleClientFactory)(tailscaleCredentials);
    await deprovisionTailscaleExposure(client, { hostname: row.hostname, authKeyId: row.tailscaleAuthKeyId });
  } else {
    const apiToken = row.kind === "managed_cloudflare" ? config.managedTunnel?.apiToken ?? null : null;
    if (!apiToken || !row.cloudflareAccountId || !row.zoneId) return "manual";
    await deprovisionDirectExposure((factories.cloudflare ?? defaultCloudflareClientFactory)(apiToken), {
      accountId: row.cloudflareAccountId,
      zoneId: row.zoneId,
      tunnelId: row.tunnelId,
      dnsRecordId: row.dnsRecordId,
      accessAppId: row.accessAppId,
      serviceTokenId: row.serviceTokenId,
    });
  }
  await withTenant(db, row.organizationId, async (tx) => {
    await tx`
      update runtime_direct_exposures set cleanup_status = 'done', error_code = null, updated_at = now()
       where organization_id = ${row.organizationId} and id = ${row.id} and cleanup_status = 'pending'`;
  });
  return "done";
}

/**
 * Le retrait d'un runtime emporte sa publication, dans la transaction du
 * retrait. Rend la ligne quand un nettoyage distant reste à faire : l'appelant
 * le lance APRÈS son commit (`cleanupRevokedExposuresAfterCommit`).
 */
export async function revokeExposureForRuntime(
  tx: Bun.TransactionSQL,
  config: ApiConfig,
  organizationId: string,
  runtimeId: string,
): Promise<RuntimeExposureRow | null> {
  const row = (await readExposureByRuntime(tx, organizationId, runtimeId))[0];
  if (!row) return null;
  return await markExposureRevoked(tx, config, row, null) === "pending" ? row : null;
}

/**
 * Après le commit d'un retrait de runtime : retire les tunnels gérés. Un
 * échec ne défait rien et ne fait pas échouer la requête, dont l'effet est
 * déjà durable : la ligne reste `pending`, le worker la reprend, et
 * l'événement le dit.
 */
export async function cleanupRevokedExposuresAfterCommit(
  db: Bun.SQL,
  config: ApiConfig,
  rows: ReadonlyArray<RuntimeExposureRow>,
  factories: ExposureClientFactories = {},
): Promise<void> {
  for (const row of rows) {
    try {
      await cleanupRevokedExposure(db, config, row, null, factories);
    } catch (error) {
      console.warn(JSON.stringify({
        event: "api.exposure_cleanup_deferred",
        organizationId: row.organizationId,
        exposureId: row.id,
        error: error instanceof Error ? error.name : "unknown",
      }));
    }
  }
}
