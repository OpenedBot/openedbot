import { asRecord } from "@openedbot/contracts-primitives";

/**
 * OHB-75 : le strict nécessaire de l'API Tailscale v2 pour publier un gateway
 * en Funnel : échange OAuth, fichier de politique (attribut `funnel` sur le
 * tag d'openedbot), clé d'appairage taguée, inventaire et retrait des machines.
 *
 * Mêmes règles que le client Cloudflare : aucun corps de réponse, aucun jeton,
 * aucun secret ne sort d'ici dans une erreur ou un log. `TailscaleApiError`
 * porte un code borné et le statut HTTP, rien d'autre. Les identifiants OAuth
 * ne voyagent que dans le corps de l'échange de jeton, le jeton d'accès dans
 * l'en-tête `Authorization`, jamais dans une URL.
 */

export type TailscaleApiErrorCode =
  | "TAILSCALE_CREDENTIALS_REJECTED"
  | "TAILSCALE_NOT_FOUND"
  | "TAILSCALE_TAILNET_UNKNOWN"
  | "TAILSCALE_CONFLICT"
  | "TAILSCALE_RATE_LIMITED"
  | "TAILSCALE_UNAVAILABLE"
  | "TAILSCALE_INVALID_RESPONSE";

export class TailscaleApiError extends Error {
  constructor(readonly code: TailscaleApiErrorCode, readonly status: number | null, message: string) {
    super(message);
    this.name = "TailscaleApiError";
  }
}

/** Le fichier de politique du tailnet, tel quel, avec son ETag pour l'écriture concurrente. */
export type TailscalePolicyFile = { policy: Record<string, unknown>; etag: string | null };
export type TailscaleDevice = { id: string; name: string; hostname: string; tags: string[] };
/** `key` n'est lisible qu'à la création ; Tailscale ne le rend jamais deux fois. */
export type TailscaleAuthKey = { id: string; key: string };

export type TailscaleApiClient = {
  readPolicy(): Promise<TailscalePolicyFile>;
  writePolicy(policy: Record<string, unknown>, etag: string | null): Promise<void>;
  listDevices(): Promise<TailscaleDevice[]>;
  deleteDevice(deviceId: string): Promise<void>;
  createAuthKey(input: { tag: string; description: string; expirySeconds: number }): Promise<TailscaleAuthKey>;
  deleteAuthKey(keyId: string): Promise<void>;
};

export type TailscaleCredentials = { clientId: string; clientSecret: string };

const TAILSCALE_API_BASE = "https://api.tailscale.com/api/v2";
/** Le tag que les machines openedbot portent ; c'est lui qui reçoit l'attribut `funnel`. */
export const TAILSCALE_OHB_TAG = "tag:ohb-hermes";
/** Suffixe de tout nom MagicDNS public. */
export const TAILSCALE_SUFFIX = ".ts.net";
const TIMEOUT_MS = 15_000;
/** `-` désigne le tailnet propriétaire du jeton : rien à demander au client. */
const TAILNET = "-";

export function createTailscaleApiClient(
  credentials: TailscaleCredentials,
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): TailscaleApiClient {
  const baseUrl = (options.baseUrl ?? TAILSCALE_API_BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  /** Un jeton vaut une heure ; une passe dure quelques secondes, un échange suffit. */
  let accessToken: string | null = null;

  async function send(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchImpl(new URL(`${baseUrl}${path}`), {
        ...init,
        method,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new TailscaleApiError("TAILSCALE_UNAVAILABLE", null, "L’API Tailscale est injoignable.");
    }
  }

  async function token(): Promise<string> {
    if (accessToken) return accessToken;
    const response = await send("POST", "/oauth/token", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }).toString(),
    });
    if (!response.ok) {
      throw new TailscaleApiError("TAILSCALE_CREDENTIALS_REJECTED", response.status, "Tailscale refuse ce client OAuth ou ses scopes.");
    }
    let payload: { access_token?: unknown };
    try {
      payload = await response.json() as { access_token?: unknown };
    } catch {
      throw new TailscaleApiError("TAILSCALE_INVALID_RESPONSE", response.status, "Réponse Tailscale illisible.");
    }
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new TailscaleApiError("TAILSCALE_INVALID_RESPONSE", response.status, "Tailscale n’a pas rendu de jeton d’accès.");
    }
    accessToken = payload.access_token;
    return accessToken;
  }

  /** Une requête authentifiée ; rend la réponse brute pour que l'appelant lise l'ETag. */
  async function call(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const bearer = await token();
    const response = await send(method, path, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.status === 401 || response.status === 403) {
      throw new TailscaleApiError("TAILSCALE_CREDENTIALS_REJECTED", response.status, "Tailscale refuse ce jeton ou ses scopes.");
    }
    if (response.status === 404) throw new TailscaleApiError("TAILSCALE_NOT_FOUND", 404, "Tailscale ne connaît pas cette ressource.");
    // 412 : le fichier de politique a changé depuis la lecture ; l'appelant relit et rejoue.
    if (response.status === 409 || response.status === 412) {
      throw new TailscaleApiError("TAILSCALE_CONFLICT", response.status, "Tailscale signale un conflit sur cette ressource.");
    }
    if (response.status === 429) throw new TailscaleApiError("TAILSCALE_RATE_LIMITED", 429, "Tailscale limite le débit ; réessayez dans un instant.");
    if (response.status >= 500) throw new TailscaleApiError("TAILSCALE_UNAVAILABLE", response.status, "L’API Tailscale est indisponible.");
    if (!response.ok) throw new TailscaleApiError("TAILSCALE_INVALID_RESPONSE", response.status, "Tailscale a refusé la requête.");
    return response;
  }

  async function json<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new TailscaleApiError("TAILSCALE_INVALID_RESPONSE", response.status, "Réponse Tailscale illisible.");
    }
  }

  return {
    async readPolicy() {
      // `application/json` : le fichier est en HuJSON par défaut, illisible par JSON.parse.
      const response = await call("GET", `/tailnet/${TAILNET}/acl`, { headers: { Accept: "application/json" } });
      const policy = await json<Record<string, unknown>>(response);
      if (!policy || typeof policy !== "object") throw new TailscaleApiError("TAILSCALE_INVALID_RESPONSE", 200, "Fichier de politique illisible.");
      return { policy, etag: response.headers.get("etag") };
    },
    async writePolicy(policy, etag) {
      await call("POST", `/tailnet/${TAILNET}/acl`, {
        body: policy,
        headers: { Accept: "application/json", ...(etag ? { "If-Match": etag } : {}) },
      });
    },
    async listDevices() {
      const payload = await json<{ devices?: Array<Record<string, unknown>> }>(await call("GET", `/tailnet/${TAILNET}/devices`));
      return (payload.devices ?? []).map((raw) => ({
        id: str(raw.id),
        name: str(raw.name),
        hostname: str(raw.hostname),
        tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
      }));
    },
    async deleteDevice(deviceId) {
      try { await call("DELETE", `/device/${enc(deviceId)}`); }
      catch (error) { if (!(error instanceof TailscaleApiError && error.code === "TAILSCALE_NOT_FOUND")) throw error; }
    },
    async createAuthKey({ tag, description, expirySeconds }) {
      const raw = await json<Record<string, unknown>>(await call("POST", `/tailnet/${TAILNET}/keys`, {
        body: {
          // Non réutilisable : une clé, une machine. Préautorisée : l'hôte joint sans validation manuelle.
          capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [tag] } } },
          expirySeconds,
          description,
        },
      }));
      const key = { id: str(raw.id), key: str(raw.key) };
      if (!key.id || !key.key) throw new TailscaleApiError("TAILSCALE_INVALID_RESPONSE", 200, "Clé d’appairage Tailscale illisible.");
      return key;
    },
    async deleteAuthKey(keyId) {
      try { await call("DELETE", `/tailnet/${TAILNET}/keys/${enc(keyId)}`); }
      catch (error) { if (!(error instanceof TailscaleApiError && error.code === "TAILSCALE_NOT_FOUND")) throw error; }
    },
  };
}

/**
 * Le domaine MagicDNS du tailnet, lu sur une machine déjà connectée.
 *
 * Il n'existe pas d'endpoint qui le dise ; `name` vaut `machine.tailnet.ts.net`
 * et tout ce qui suit le premier label est le domaine. Un tailnet sans aucune
 * machine ne permet donc pas de prédire le hostname : l'appelant le signale.
 */
export function tailnetDomainFromDevices(devices: readonly TailscaleDevice[]): string | null {
  for (const device of devices) {
    const domain = device.name.split(".").slice(1).join(".").toLowerCase();
    if (domain.endsWith(TAILSCALE_SUFFIX.slice(1))) return domain;
  }
  return null;
}

/**
 * Ajoute au fichier de politique ce que Funnel exige, sans rien retirer :
 * le tag d'openedbot dans `tagOwners`, et l'attribut `funnel` sur ce tag dans
 * `nodeAttrs`. Rend `changed: false` quand les deux sont déjà là, pour
 * n'écrire le fichier d'un client que lorsque c'est nécessaire.
 *
 * Les deux casses (`tagOwners` et `TagOwners`) circulent dans les fichiers
 * existants : on écrit dans celle qu'on trouve, sinon en minuscules.
 */
export function policyWithFunnelTag(
  policy: Record<string, unknown>,
  tag: string,
  owners: readonly string[] = ["autogroup:admin"],
): { policy: Record<string, unknown>; changed: boolean } {
  const next = { ...policy };
  let changed = false;

  const tagOwnersKey = "TagOwners" in next ? "TagOwners" : "tagOwners";
  const tagOwners = { ...asRecord(next[tagOwnersKey]) };
  if (!Array.isArray(tagOwners[tag])) {
    tagOwners[tag] = [...owners];
    next[tagOwnersKey] = tagOwners;
    changed = true;
  }

  const nodeAttrsKey = "NodeAttrs" in next ? "NodeAttrs" : "nodeAttrs";
  const nodeAttrs = Array.isArray(next[nodeAttrsKey]) ? [...next[nodeAttrsKey] as unknown[]] : [];
  const grantsFunnel = nodeAttrs.some((entry) => {
    const record = asRecord(entry);
    if (!record) return false;
    const target = record.target ?? record.Target;
    const attr = record.attr ?? record.Attr;
    return Array.isArray(target) && target.includes(tag) && Array.isArray(attr) && attr.includes("funnel");
  });
  if (!grantsFunnel) {
    nodeAttrs.push({ target: [tag], attr: ["funnel"] });
    next[nodeAttrsKey] = nodeAttrs;
    changed = true;
  }

  return { policy: next, changed };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
