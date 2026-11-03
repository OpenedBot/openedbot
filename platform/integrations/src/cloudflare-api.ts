/**
 * OHB-75 : le strict nécessaire de l'API Cloudflare v4 pour publier un gateway
 * direct : tunnel nommé, ingress, DNS, application Access et service token.
 *
 * Lu par l'API (provisioning, compensation) et par le worker (état des tunnels
 * gérés). Aucun corps de réponse, aucun token, aucun secret ne sort d'ici dans
 * une erreur ou un log : `CloudflareApiError` porte un code borné et le statut
 * HTTP, rien d'autre. Le token API voyage dans l'en-tête `Authorization` du
 * client construit, jamais dans une URL.
 */

export type CloudflareApiErrorCode =
  | "CLOUDFLARE_TOKEN_REJECTED"
  | "CLOUDFLARE_NOT_FOUND"
  | "CLOUDFLARE_CONFLICT"
  | "CLOUDFLARE_RATE_LIMITED"
  | "CLOUDFLARE_UNAVAILABLE"
  | "CLOUDFLARE_INVALID_RESPONSE";

export class CloudflareApiError extends Error {
  constructor(readonly code: CloudflareApiErrorCode, readonly status: number | null, message: string) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export type CloudflareTunnel = { id: string; name: string; status: "inactive" | "degraded" | "healthy" | "down" | string; deletedAt: string | null };
export type CloudflareDnsRecord = { id: string; name: string; type: string; content: string };
/** `accountId` : le compte propriétaire de la zone, ce qui évite de demander un id de compte au client. */
export type CloudflareZone = { id: string; name: string; accountId: string };
export type CloudflareAccessApp = { id: string; domain: string; name: string };
export type CloudflareServiceToken = { id: string; name: string; clientId: string; clientSecret: string };
export type CloudflareTokenVerification = { id: string; status: string };

export type CloudflareApiClient = {
  verifyToken(): Promise<CloudflareTokenVerification>;
  listZones(name: string): Promise<CloudflareZone[]>;
  findTunnel(accountId: string, name: string): Promise<CloudflareTunnel | null>;
  createTunnel(accountId: string, name: string): Promise<CloudflareTunnel>;
  readTunnel(accountId: string, tunnelId: string): Promise<CloudflareTunnel>;
  putTunnelIngress(accountId: string, tunnelId: string, hostname: string, service: string): Promise<void>;
  readTunnelToken(accountId: string, tunnelId: string): Promise<string>;
  deleteTunnel(accountId: string, tunnelId: string): Promise<void>;
  findDnsRecord(zoneId: string, name: string): Promise<CloudflareDnsRecord | null>;
  upsertTunnelCname(zoneId: string, name: string, tunnelId: string): Promise<CloudflareDnsRecord>;
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
  findAccessApp(accountId: string, domain: string): Promise<CloudflareAccessApp | null>;
  createAccessApp(accountId: string, domain: string, name: string): Promise<CloudflareAccessApp>;
  deleteAccessApp(accountId: string, appId: string): Promise<void>;
  createServiceToken(accountId: string, name: string): Promise<CloudflareServiceToken>;
  deleteServiceToken(accountId: string, tokenId: string): Promise<void>;
  createServiceAuthPolicy(accountId: string, appId: string, serviceTokenId: string, name: string): Promise<void>;
};

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;

type Envelope<T> = { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> };

/** La cible CNAME d'un tunnel nommé : ce que Cloudflare proxifie vers cloudflared. */
export function cloudflareTunnelCname(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

export function createCloudflareApiClient(
  apiToken: string,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): CloudflareApiClient {
  const baseUrl = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new CloudflareApiError("CLOUDFLARE_UNAVAILABLE", null, "L’API Cloudflare est injoignable.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new CloudflareApiError("CLOUDFLARE_TOKEN_REJECTED", response.status, "Cloudflare refuse ce token API ou ses permissions.");
    }
    if (response.status === 404) throw new CloudflareApiError("CLOUDFLARE_NOT_FOUND", 404, "Cloudflare ne connaît pas cette ressource.");
    if (response.status === 409) throw new CloudflareApiError("CLOUDFLARE_CONFLICT", 409, "Cloudflare signale un conflit sur cette ressource.");
    if (response.status === 429) throw new CloudflareApiError("CLOUDFLARE_RATE_LIMITED", 429, "Cloudflare limite le débit ; réessayez dans un instant.");
    if (response.status >= 500) throw new CloudflareApiError("CLOUDFLARE_UNAVAILABLE", response.status, "L’API Cloudflare est indisponible.");
    let envelope: Envelope<T>;
    try {
      envelope = await response.json() as Envelope<T>;
    } catch {
      throw new CloudflareApiError("CLOUDFLARE_INVALID_RESPONSE", response.status, "Réponse Cloudflare illisible.");
    }
    if (!response.ok || envelope.success === false) {
      // 400 with a duplicate-name error is the idempotency signal callers look for.
      const duplicate = (envelope.errors ?? []).some((error) => /already exists|duplicate/i.test(error.message ?? ""));
      throw new CloudflareApiError(duplicate ? "CLOUDFLARE_CONFLICT" : "CLOUDFLARE_INVALID_RESPONSE", response.status, duplicate
        ? "Cloudflare signale un conflit sur cette ressource."
        : "Cloudflare a refusé la requête.");
    }
    if (envelope.result === undefined) throw new CloudflareApiError("CLOUDFLARE_INVALID_RESPONSE", response.status, "Réponse Cloudflare sans résultat.");
    return envelope.result;
  }

  const tunnel = (raw: Record<string, unknown>): CloudflareTunnel => ({
    id: str(raw.id), name: str(raw.name), status: str(raw.status) || "inactive",
    deletedAt: typeof raw.deleted_at === "string" ? raw.deleted_at : null,
  });
  const dns = (raw: Record<string, unknown>): CloudflareDnsRecord => ({ id: str(raw.id), name: str(raw.name), type: str(raw.type), content: str(raw.content) });
  const app = (raw: Record<string, unknown>): CloudflareAccessApp => ({ id: str(raw.id), domain: str(raw.domain), name: str(raw.name) });

  return {
    async verifyToken() {
      const raw = await call<Record<string, unknown>>("GET", "/user/tokens/verify");
      return { id: str(raw.id), status: str(raw.status) };
    },
    async listZones(name) {
      const rows = await call<Array<Record<string, unknown>>>("GET", "/zones", undefined, { name, per_page: "5" });
      return rows.map((raw) => {
        const account = raw.account && typeof raw.account === "object" ? raw.account as Record<string, unknown> : {};
        return { id: str(raw.id), name: str(raw.name), accountId: str(account.id) };
      });
    },
    async findTunnel(accountId, name) {
      const rows = await call<Array<Record<string, unknown>>>("GET", `/accounts/${enc(accountId)}/cfd_tunnel`, undefined, { name, is_deleted: "false", per_page: "5" });
      const found = rows.map(tunnel).find((row) => row.name === name && row.deletedAt === null);
      return found ?? null;
    },
    async createTunnel(accountId, name) {
      return tunnel(await call<Record<string, unknown>>("POST", `/accounts/${enc(accountId)}/cfd_tunnel`, { name, config_src: "cloudflare" }));
    },
    async readTunnel(accountId, tunnelId) {
      return tunnel(await call<Record<string, unknown>>("GET", `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}`));
    },
    async putTunnelIngress(accountId, tunnelId, hostname, service) {
      await call("PUT", `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/configurations`, {
        config: { ingress: [{ hostname, service }, { service: "http_status:404" }] },
      });
    },
    async readTunnelToken(accountId, tunnelId) {
      const token = await call<unknown>("GET", `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/token`);
      if (typeof token !== "string" || token.length < 40) throw new CloudflareApiError("CLOUDFLARE_INVALID_RESPONSE", 200, "Jeton de tunnel illisible.");
      return token;
    },
    async deleteTunnel(accountId, tunnelId) {
      try { await call("DELETE", `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/connections`); }
      catch (error) { if (!(error instanceof CloudflareApiError && error.code === "CLOUDFLARE_NOT_FOUND")) throw error; }
      try { await call("DELETE", `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}`); }
      catch (error) { if (!(error instanceof CloudflareApiError && error.code === "CLOUDFLARE_NOT_FOUND")) throw error; }
    },
    async findDnsRecord(zoneId, name) {
      const rows = await call<Array<Record<string, unknown>>>("GET", `/zones/${enc(zoneId)}/dns_records`, undefined, { name, per_page: "5" });
      return rows.map(dns).find((row) => row.name === name) ?? null;
    },
    async upsertTunnelCname(zoneId, name, tunnelId) {
      const payload = { type: "CNAME", name, content: cloudflareTunnelCname(tunnelId), proxied: true, ttl: 1, comment: "openedbot direct runtime" };
      const existing = await this.findDnsRecord(zoneId, name);
      if (existing) return dns(await call<Record<string, unknown>>("PUT", `/zones/${enc(zoneId)}/dns_records/${enc(existing.id)}`, payload));
      return dns(await call<Record<string, unknown>>("POST", `/zones/${enc(zoneId)}/dns_records`, payload));
    },
    async deleteDnsRecord(zoneId, recordId) {
      try { await call("DELETE", `/zones/${enc(zoneId)}/dns_records/${enc(recordId)}`); }
      catch (error) { if (!(error instanceof CloudflareApiError && error.code === "CLOUDFLARE_NOT_FOUND")) throw error; }
    },
    async findAccessApp(accountId, domain) {
      const rows = await call<Array<Record<string, unknown>>>("GET", `/accounts/${enc(accountId)}/access/apps`, undefined, { domain, per_page: "5" });
      return rows.map(app).find((row) => row.domain === domain) ?? null;
    },
    async createAccessApp(accountId, domain, name) {
      return app(await call<Record<string, unknown>>("POST", `/accounts/${enc(accountId)}/access/apps`, {
        type: "self_hosted", name, domain, session_duration: "24h", app_launcher_visible: false, allowed_idps: [], auto_redirect_to_identity: false,
      }));
    },
    async deleteAccessApp(accountId, appId) {
      try { await call("DELETE", `/accounts/${enc(accountId)}/access/apps/${enc(appId)}`); }
      catch (error) { if (!(error instanceof CloudflareApiError && error.code === "CLOUDFLARE_NOT_FOUND")) throw error; }
    },
    async createServiceToken(accountId, name) {
      const raw = await call<Record<string, unknown>>("POST", `/accounts/${enc(accountId)}/access/service_tokens`, { name, duration: "8760h" });
      const token = { id: str(raw.id), name: str(raw.name), clientId: str(raw.client_id), clientSecret: str(raw.client_secret) };
      if (!token.id || !token.clientId || !token.clientSecret) throw new CloudflareApiError("CLOUDFLARE_INVALID_RESPONSE", 200, "Service token Access illisible.");
      return token;
    },
    async deleteServiceToken(accountId, tokenId) {
      try { await call("DELETE", `/accounts/${enc(accountId)}/access/service_tokens/${enc(tokenId)}`); }
      catch (error) { if (!(error instanceof CloudflareApiError && error.code === "CLOUDFLARE_NOT_FOUND")) throw error; }
    },
    async createServiceAuthPolicy(accountId, appId, serviceTokenId, name) {
      await call("POST", `/accounts/${enc(accountId)}/access/apps/${enc(appId)}/policies`, {
        name, decision: "non_identity", precedence: 1, include: [{ service_token: { token_id: serviceTokenId } }],
      });
    },
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
