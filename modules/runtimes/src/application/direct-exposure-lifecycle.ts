import { createCloudflareApiClient, type CloudflareApiClient } from "@openedbot/platform-integrations/cloudflare-api";
import { createTailscaleApiClient, type TailscaleApiClient, type TailscaleCredentials } from "@openedbot/platform-integrations/tailscale-api";
import type { RuntimeExposureRevokedDto } from "@openedbot/contracts-api";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
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

/**
 * Révoque une exposition et retire ce qu'elle a posé chez le fournisseur quand
 * des identifiants le permettent : le token Cloudflare d'openedbot pour un tunnel
 * géré, le client OAuth que le propriétaire du tailnet vient de fournir pour
 * une publication Funnel. Sans identifiants, la ligne est révoquée et la
 * réponse dit que le nettoyage reste à faire à la main.
 *
 * La révocation en base est écrite AVANT le retrait distant : un retrait qui
 * échoue à moitié ne doit pas laisser une exposition « vivante » qui pointe
 * vers des ressources déjà supprimées. L'échec du fournisseur ressort ensuite.
 *
 * Les publications `customer_cloudflare`, qui n'existent plus que dans
 * l'historique, n'ont plus de token pour être nettoyées : elles sont révoquées
 * chez openedbot et laissées à la main sur le compte du client.
 */
export async function revokeExposure(
  tx: Bun.TransactionSQL,
  config: ApiConfig,
  row: RuntimeExposureRow,
  tailscaleCredentials: TailscaleCredentials | null,
  factories: ExposureClientFactories = {},
): Promise<RuntimeExposureRevokedDto> {
  await tx`
    update runtime_direct_exposures
       set status = 'revoked', revoked_at = coalesce(revoked_at, now()), updated_at = now(),
           install_token_ciphertext = null, install_token_nonce = null, install_token_tag = null, install_token_key_id = null,
           edge_auth_ciphertext = null, edge_auth_nonce = null, edge_auth_tag = null, edge_auth_key_id = null
     where organization_id = ${row.organizationId} and id = ${row.id}`;

  if (row.kind === "tailscale_funnel") {
    if (!tailscaleCredentials) return { ok: true, cloudflareCleanup: row.tailscaleAuthKeyId ? "manual" : "none" };
    const client = (factories.tailscale ?? defaultTailscaleClientFactory)(tailscaleCredentials);
    await deprovisionTailscaleExposure(client, { hostname: row.hostname, authKeyId: row.tailscaleAuthKeyId });
    return { ok: true, cloudflareCleanup: "done" };
  }

  const apiToken = row.kind === "managed_cloudflare" ? config.managedTunnel?.apiToken ?? null : null;
  if (!apiToken || !row.cloudflareAccountId || !row.zoneId) return { ok: true, cloudflareCleanup: "manual" };
  await deprovisionDirectExposure((factories.cloudflare ?? defaultCloudflareClientFactory)(apiToken), {
    accountId: row.cloudflareAccountId,
    zoneId: row.zoneId,
    tunnelId: row.tunnelId,
    dnsRecordId: row.dnsRecordId,
    accessAppId: row.accessAppId,
    serviceTokenId: row.serviceTokenId,
  });
  return { ok: true, cloudflareCleanup: "done" };
}

/** Le retrait d'un runtime emporte sa publication ; un tunnel géré est retiré du compte openedbot. */
export async function revokeExposureForRuntime(
  tx: Bun.TransactionSQL,
  config: ApiConfig,
  organizationId: string,
  runtimeId: string,
  factories: ExposureClientFactories = {},
): Promise<RuntimeExposureRevokedDto | null> {
  const row = (await readExposureByRuntime(tx, organizationId, runtimeId))[0];
  if (!row) return null;
  return revokeExposure(tx, config, row, null, factories);
}
