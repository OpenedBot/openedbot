import { CloudflareApiError, type CloudflareApiClient } from "@openedbot/platform-integrations/cloudflare-api";

/**
 * Publier un gateway direct sur Cloudflare, en une passe.
 *
 * Tunnel nommé (config côté Cloudflare), ingress vers le loopback du gateway,
 * CNAME proxifié, application Access self-hosted avec une politique Service
 * Auth et son service token. Idempotent par nom : un tunnel, une application
 * ou un enregistrement DNS qui existent déjà sont repris, pas dupliqués. Si une
 * étape échoue, tout ce que CETTE passe a créé est retiré dans l'ordre inverse,
 * et l'erreur d'origine ressort.
 *
 * Le service token ne se relit jamais : Cloudflare rend son secret une seule
 * fois. Une passe rejouée sur une application existante crée donc un nouveau
 * token et une nouvelle politique ; l'ancien token reste valable jusqu'à sa
 * suppression par la compensation ou la révocation.
 */
export type DirectExposureProvisionInput = {
  accountId: string;
  zoneId: string;
  hostname: string;
  tunnelName: string;
  accessName: string;
  /** Ce que cloudflared joint sur l'hôte ; le gateway Hermes par défaut. */
  originService?: string;
};

export type DirectExposureProvisionResult = {
  tunnelId: string;
  dnsRecordId: string;
  accessAppId: string;
  serviceTokenId: string;
  /** Le jeton `cloudflared service install <jeton>` ; rendu au client une fois, chiffré ensuite. */
  installToken: string;
  edgeAuth: { clientId: string; clientSecret: string };
};

export const HERMES_ORIGIN_SERVICE = "http://127.0.0.1:8642";

export async function provisionDirectExposure(
  client: CloudflareApiClient,
  input: DirectExposureProvisionInput,
): Promise<DirectExposureProvisionResult> {
  const undo: Array<() => Promise<void>> = [];
  const rollback = async (): Promise<void> => {
    for (const step of undo.reverse()) {
      try { await step(); } catch { /* best effort: the original error is what the caller sees */ }
    }
  };
  try {
    let tunnel = await client.findTunnel(input.accountId, input.tunnelName);
    if (!tunnel) {
      tunnel = await client.createTunnel(input.accountId, input.tunnelName);
      const tunnelId = tunnel.id;
      undo.push(() => client.deleteTunnel(input.accountId, tunnelId));
    }
    await client.putTunnelIngress(input.accountId, tunnel.id, input.hostname, input.originService ?? HERMES_ORIGIN_SERVICE);

    const existingRecord = await client.findDnsRecord(input.zoneId, input.hostname);
    const record = await client.upsertTunnelCname(input.zoneId, input.hostname, tunnel.id);
    if (!existingRecord) undo.push(() => client.deleteDnsRecord(input.zoneId, record.id));

    let app = await client.findAccessApp(input.accountId, input.hostname);
    if (!app) {
      app = await client.createAccessApp(input.accountId, input.hostname, input.accessName);
      const appId = app.id;
      undo.push(() => client.deleteAccessApp(input.accountId, appId));
    }
    const serviceToken = await client.createServiceToken(input.accountId, input.accessName);
    undo.push(() => client.deleteServiceToken(input.accountId, serviceToken.id));
    await client.createServiceAuthPolicy(input.accountId, app.id, serviceToken.id, `${input.accessName} service auth`);

    const installToken = await client.readTunnelToken(input.accountId, tunnel.id);
    return {
      tunnelId: tunnel.id,
      dnsRecordId: record.id,
      accessAppId: app.id,
      serviceTokenId: serviceToken.id,
      installToken,
      edgeAuth: { clientId: serviceToken.clientId, clientSecret: serviceToken.clientSecret },
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}

export type DirectExposureResources = {
  accountId: string;
  zoneId: string;
  tunnelId: string | null;
  dnsRecordId: string | null;
  accessAppId: string | null;
  serviceTokenId: string | null;
};

/**
 * Retire ce qu'une publication a créé. Une ressource déjà absente n'est pas une
 * erreur ; tout autre échec ressort après avoir tenté les autres retraits, pour
 * que rien ne reste orphelin par effet de bord d'un seul refus.
 */
export async function deprovisionDirectExposure(client: CloudflareApiClient, resources: DirectExposureResources): Promise<void> {
  let failure: unknown = null;
  const attempt = async (step: () => Promise<void>): Promise<void> => {
    try { await step(); } catch (error) {
      if (error instanceof CloudflareApiError && error.code === "CLOUDFLARE_NOT_FOUND") return;
      failure ??= error;
    }
  };
  if (resources.serviceTokenId) await attempt(() => client.deleteServiceToken(resources.accountId, resources.serviceTokenId!));
  if (resources.accessAppId) await attempt(() => client.deleteAccessApp(resources.accountId, resources.accessAppId!));
  if (resources.dnsRecordId) await attempt(() => client.deleteDnsRecord(resources.zoneId, resources.dnsRecordId!));
  if (resources.tunnelId) await attempt(() => client.deleteTunnel(resources.accountId, resources.tunnelId!));
  if (failure) throw failure;
}
