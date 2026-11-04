import { isoOrNull } from "@openedbot/contracts-primitives";
import type { RuntimeExposureDto, RuntimeExposureStatus, RuntimeExposureStoredKind, RuntimePublicDto } from "@openedbot/contracts-api";

/**
 * OHB-75 : la table `runtime_direct_exposures` (0058), lue et écrite sous RLS.
 *
 * Partagé par les routes runtime (résumé joint au DTO public) et les routes
 * d'exposition (cycle de vie), qui ne s'importent pas l'une l'autre.
 */
export type RuntimeExposureRow = {
  id: string;
  organizationId: string;
  runtimeId: string | null;
  kind: RuntimeExposureStoredKind;
  hostname: string;
  endpoint: string;
  cloudflareAccountId: string | null;
  zoneId: string | null;
  tunnelId: string | null;
  dnsRecordId: string | null;
  accessAppId: string | null;
  serviceTokenId: string | null;
  /** OHB-75 : la clé d'appairage Tailscale à révoquer ; `null` hors Funnel. */
  tailscaleAuthKeyId: string | null;
  installTokenCiphertext: string | null;
  installTokenNonce: string | null;
  installTokenTag: string | null;
  installTokenKeyId: string | null;
  edgeAuthCiphertext: string | null;
  edgeAuthNonce: string | null;
  edgeAuthTag: string | null;
  edgeAuthKeyId: string | null;
  status: RuntimeExposureStatus;
  lastTunnelStatus: string | null;
  lastCheckedAt: Date | string | null;
  errorCode: string | null;
  createdAt: Date | string;
  revokedAt: Date | string | null;
  /** 0171 : le retrait distant après révocation ; lu par la révocation seulement. */
  cleanupStatus?: "pending" | "done" | "manual" | null;
};

export type RuntimeExposureSummary = NonNullable<RuntimePublicDto["exposure"]>;

export function readExposureById(tx: Bun.TransactionSQL, organizationId: string, id: string) {
  return tx<RuntimeExposureRow[]>`
    select id, organization_id as "organizationId", runtime_id as "runtimeId", kind, hostname, endpoint,
           cloudflare_account_id as "cloudflareAccountId", zone_id as "zoneId", tunnel_id as "tunnelId",
           dns_record_id as "dnsRecordId", access_app_id as "accessAppId", service_token_id as "serviceTokenId", tailscale_auth_key_id as "tailscaleAuthKeyId",
           install_token_ciphertext as "installTokenCiphertext", install_token_nonce as "installTokenNonce",
           install_token_tag as "installTokenTag", install_token_key_id as "installTokenKeyId",
           edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
           edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId",
           status, last_tunnel_status as "lastTunnelStatus", last_checked_at as "lastCheckedAt", error_code as "errorCode",
           created_at as "createdAt", revoked_at as "revokedAt", cleanup_status as "cleanupStatus"
      from runtime_direct_exposures
     where organization_id = ${organizationId} and id = ${id}
     limit 1`;
}

export function readExposureByRuntime(tx: Bun.TransactionSQL, organizationId: string, runtimeId: string) {
  return tx<RuntimeExposureRow[]>`
    select id, organization_id as "organizationId", runtime_id as "runtimeId", kind, hostname, endpoint,
           cloudflare_account_id as "cloudflareAccountId", zone_id as "zoneId", tunnel_id as "tunnelId",
           dns_record_id as "dnsRecordId", access_app_id as "accessAppId", service_token_id as "serviceTokenId", tailscale_auth_key_id as "tailscaleAuthKeyId",
           install_token_ciphertext as "installTokenCiphertext", install_token_nonce as "installTokenNonce",
           install_token_tag as "installTokenTag", install_token_key_id as "installTokenKeyId",
           edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
           edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId",
           status, last_tunnel_status as "lastTunnelStatus", last_checked_at as "lastCheckedAt", error_code as "errorCode",
           created_at as "createdAt", revoked_at as "revokedAt"
      from runtime_direct_exposures
     where organization_id = ${organizationId} and runtime_id = ${runtimeId} and revoked_at is null
     order by created_at desc limit 1`;
}

/**
 * Les publications encore sans runtime : ni déclarées, ni révoquées.
 *
 * C'est ce que le registre montre pour qu'une publication abandonnée en cours
 * de route reste reprenable ou révocable, au lieu de tenir des ressources chez
 * le fournisseur sans que personne ne puisse la voir.
 */
export function readPendingExposures(tx: Bun.TransactionSQL, organizationId: string) {
  return tx<RuntimeExposureRow[]>`
    select id, organization_id as "organizationId", runtime_id as "runtimeId", kind, hostname, endpoint,
           cloudflare_account_id as "cloudflareAccountId", zone_id as "zoneId", tunnel_id as "tunnelId",
           dns_record_id as "dnsRecordId", access_app_id as "accessAppId", service_token_id as "serviceTokenId", tailscale_auth_key_id as "tailscaleAuthKeyId",
           install_token_ciphertext as "installTokenCiphertext", install_token_nonce as "installTokenNonce",
           install_token_tag as "installTokenTag", install_token_key_id as "installTokenKeyId",
           edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
           edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId",
           status, last_tunnel_status as "lastTunnelStatus", last_checked_at as "lastCheckedAt", error_code as "errorCode",
           created_at as "createdAt", revoked_at as "revokedAt"
      from runtime_direct_exposures
     where organization_id = ${organizationId} and runtime_id is null and revoked_at is null
     order by created_at desc
     limit 20`;
}

/** Le résumé joint à chaque runtime `direct` du registre ; une requête pour toute l'organisation. */
export async function readExposureSummaries(tx: Bun.TransactionSQL, organizationId: string): Promise<Map<string, RuntimeExposureSummary>> {
  const rows = await tx<Array<{ id: string; runtimeId: string; kind: RuntimeExposureStoredKind; hostname: string; lastTunnelStatus: string | null }>>`
    select id, runtime_id as "runtimeId", kind, hostname, last_tunnel_status as "lastTunnelStatus"
      from runtime_direct_exposures
     where organization_id = ${organizationId} and runtime_id is not null and revoked_at is null
     order by created_at asc`;
  const summaries = new Map<string, RuntimeExposureSummary>();
  for (const row of rows) summaries.set(row.runtimeId, { id: row.id, kind: row.kind, hostname: row.hostname, lastTunnelStatus: row.lastTunnelStatus });
  return summaries;
}

export function publicExposure(row: RuntimeExposureRow): RuntimeExposureDto {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    hostname: row.hostname,
    endpoint: row.endpoint,
    runtimeId: row.runtimeId,
    edgeAuthProvisioned: row.serviceTokenId !== null,
    lastTunnelStatus: row.lastTunnelStatus,
    lastCheckedAt: isoOrNull(row.lastCheckedAt),
    errorCode: row.errorCode,
    createdAt: isoOrNull(row.createdAt) ?? new Date().toISOString(),
  };
}
