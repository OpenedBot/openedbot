import {
  HermesClientError,
  createDirectTransport,
  normalizeHermesEndpoint,
  type HermesClientConfig,
} from "@openedbot/hermes";
import { decryptSecretFromKeyring, SecretDecryptionError } from "@openedbot/hermes/secrets";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { RuntimeEdgeAuthInput } from "@openedbot/contracts-api";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { runtimeLinkClientConfig, runtimeLinks, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import {
  runtimeLinkLocator,
  unavailableMessage,
  type LinkUnavailableDetail,
  type RuntimeLinkLocator,
} from "@openedbot/runtime-link/application/instances";
import { readRuntimeRowById, readRuntimeRows, type RuntimeRow } from "../sql/runtime-rows";

/** Persisted active runtime identity and last announced link features, with no connector reachability check. */
export async function readRegisteredRuntimeForCleanup(
  db: Db,
  organizationId: string,
): Promise<{ id: string; linkFeatures: string[] } | null> {
  return withTenant(db, organizationId, async (tx) => {
    const runtime = (await readRuntimeRows(tx, organizationId))[0];
    return runtime ? { id: runtime.id, linkFeatures: runtime.reachability === "connector" ? runtime.linkFeatures : [] } : null;
  });
}

/**
 * Ce que l'accès à un runtime lit de la configuration de l'API : le trousseau
 * des jetons, la politique d'endpoint et l'identité mTLS. Le reste de
 * `ApiConfig` n'entre pas ici.
 */
export type RuntimeAccessConfig = Pick<ApiConfig, "tokenEncryption" | "hermesEndpointPolicy" | "hermesMtls" | "hermesTimeouts">;

/** Read the active runtime, or an explicitly selected inactive runtime, and its client. */
export async function readRuntimeSecret(
  db: Db,
  config: RuntimeAccessConfig,
  organizationId: string,
  links: RuntimeLinks = runtimeLinks(),
  locator: RuntimeLinkLocator = runtimeLinkLocator(),
  runtimeId?: string,
): Promise<{
  id: string;
  name: string;
  capacity: number;
  linkFeatures: string[];
  client: HermesClientConfig;
  selectedProvider: string | null;
  selectedModel: string | null;
  reasoningEffort: string | null;
  /** Voir `inventoryWatch` : quand l'hôte a dit son inventaire changé, et s'il le surveille. */
  inventory?: InventoryWatch;
} | null> {
  const runtime = await withTenant(db, organizationId, async (tx) => {
    const rows = runtimeId ? await readRuntimeRowById(tx, organizationId, runtimeId) : await readRuntimeRows(tx, organizationId);
    const selected = rows[0] ?? null;
    return selected;
  });
  if (!runtime) return null;
  if (runtime.reachability === "connector") await assertLinkReachable(runtime.id, links, locator);
  return {
    id: runtime.id,
    name: runtime.name,
    capacity: runtime.capacity,
    linkFeatures: runtime.reachability === "connector" ? runtime.linkFeatures : [],
    client: runtimeClientConfig(runtime, config, links),
    selectedProvider: runtime.selectedProvider,
    selectedModel: runtime.selectedModel,
    reasoningEffort: runtime.reasoningEffort,
    inventory: inventoryWatch(runtime),
  };
}

/**
 * Ce que le connecteur dit de l'inventaire de son hôte (0160).
 *
 * `changedAt` : le dernier `inventory.changed` ; un instantané observé avant
 * est périmé. `watched` : l'hôte en a envoyé un depuis la connexion en cours
 * (le connecteur en envoie un à chaque connexion, puis à chaque changement) :
 * tant que le lien tient, un instantané plus récent reste juste.
 */
export type InventoryWatch = { changedAt: Date | null; watched: boolean };

export function inventoryWatch(runtime: Pick<RuntimeRow, "reachability" | "linkConnectedAt" | "inventoryChangedAt">): InventoryWatch {
  const changedAt = runtime.inventoryChangedAt ?? null;
  const watched = runtime.reachability === "connector"
    && changedAt !== null
    && runtime.linkConnectedAt !== null
    && changedAt.getTime() >= runtime.linkConnectedAt.getTime();
  return { changedAt, watched };
}

export async function assertLinkReachable(
  runtimeId: string,
  links: RuntimeLinks,
  locator: RuntimeLinkLocator,
): Promise<void> {
  if (links.connected(runtimeId)) return;
  const location = await locator.locate(runtimeId);
  if (location.kind === "remote") return;
  throw runtimeLinkUnavailable(location.kind === "unavailable" ? location.detail : "no_link");
}

/** Decrypt direct credentials with the keyring; preserve the connector relay. */
export function runtimeClientConfig(row: RuntimeRow, config: RuntimeAccessConfig, links: RuntimeLinks): HermesClientConfig {
  if (row.reachability === "connector") return { ...linkClientConfig(row.id, links), timeouts: config.hermesTimeouts };
  const token = decryptRuntimeToken(row, config).value;
  return directConfig(directCredentials(row).endpoint, token, decryptEdgeAuth(row, config), config);
}

function linkClientConfig(runtimeId: string, links: RuntimeLinks): HermesClientConfig {
  return runtimeLinkClientConfig(runtimeId, links);
}

/** Ciphertext envelope only; callers must explicitly decrypt through the keyring. */
export function directCredentials(row: RuntimeRow): { endpoint: string; ciphertext: string; nonce: string; tag: string } {
  if (
    row.reachability !== "direct" ||
    row.endpoint === null ||
    row.tokenCiphertext === null ||
    row.tokenNonce === null ||
    row.tokenTag === null
  ) {
    throw runtimeLinkUnavailable();
  }
  return { endpoint: row.endpoint, ciphertext: row.tokenCiphertext, nonce: row.tokenNonce, tag: row.tokenTag };
}

function runtimeLinkUnavailable(detail: LinkUnavailableDetail = "no_link"): HttpError {
  return new HttpError(
    503,
    "RUNTIME_LINK_UNAVAILABLE",
    unavailableMessage(detail),
    {},
    detail,
  );
}

export function decryptRuntimeToken(row: RuntimeRow, config: RuntimeAccessConfig) {
  const credentials = directCredentials(row);
  try {
    return decryptSecretFromKeyring(
      { ciphertext: credentials.ciphertext, nonce: credentials.nonce, tag: credentials.tag },
      row.tokenKeyId,
      config.tokenEncryption,
    );
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      throw new HttpError(
        500,
        "RUNTIME_TOKEN_DECRYPTION_FAILED",
        "Le token Hermes ne peut pas être déchiffré. Restaurez la clé précédente ou remplacez le token.",
      );
    }
    throw error;
  }
}

export function optionalDirectToken(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 4_096 || /[\r\n\0]/.test(value)) {
    throw new HttpError(400, "RUNTIME_TOKEN_INVALID", "Le bearer Hermes est invalide.");
  }
  return value.trim();
}

export function readEdgeAuthInput(value: unknown): RuntimeEdgeAuthInput | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["clientId", "clientSecret"].includes(key))) {
    throw new HttpError(400, "VALIDATION_ERROR", "Le service token Access est invalide.");
  }
  const input = value as Record<string, unknown>;
  const clientId = optionalDirectToken(input.clientId);
  const clientSecret = optionalDirectToken(input.clientSecret);
  if (!clientId || !clientSecret) throw new HttpError(400, "VALIDATION_ERROR", "Les deux champs du service token Access sont requis.");
  return { clientId, clientSecret };
}

export function decryptEdgeAuth(row: RuntimeRow, config: RuntimeAccessConfig): RuntimeEdgeAuthInput | null {
  if (!row.edgeAuthCiphertext) return null;
  try {
    if (!row.edgeAuthNonce || !row.edgeAuthTag || !row.edgeAuthKeyId) throw new Error();
    const decrypted = decryptSecretFromKeyring({ ciphertext: row.edgeAuthCiphertext, nonce: row.edgeAuthNonce, tag: row.edgeAuthTag }, row.edgeAuthKeyId, config.tokenEncryption);
    return readEdgeAuthInput(JSON.parse(decrypted.value));
  } catch {
    throw new HttpError(500, "RUNTIME_EDGE_AUTH_DECRYPTION_FAILED", "Le service token Access ne peut pas être déchiffré. Restaurez la clé précédente ou remplacez-le.");
  }
}

export function directConfig(url: string, token: string, edge: RuntimeEdgeAuthInput | null, config: RuntimeAccessConfig): HermesClientConfig {
  let endpoint: string;
  try { endpoint = normalizeHermesEndpoint(url, config.hermesEndpointPolicy); }
  catch (error) {
    if (error instanceof Error && error.name === "RUNTIME_QUICK_TUNNEL_REFUSED") {
      const refused = new HttpError(400, "RUNTIME_QUICK_TUNNEL_REFUSED", "Tunnel nommé requis : reprenez l’étape 1.");
      refused.name = "RUNTIME_QUICK_TUNNEL_REFUSED";
      throw refused;
    }
    throw error;
  }
  // A direct bearer belongs to the root gateway, never a named profile.
  if (/\/p\/[^/]+(?:\/|$)/.test(new URL(endpoint).pathname)) {
    throw new HttpError(400, "HERMES_URL_INVALID", "L’accès direct exige l’URL racine du gateway, sans profil nommé.");
  }
  const direct = createDirectTransport({ endpoint, token, policy: config.hermesEndpointPolicy, mtls: config.hermesMtls,
    headers: edge ? { "CF-Access-Client-Id": edge.clientId, "CF-Access-Client-Secret": edge.clientSecret } : undefined });
  return { profile: null, timeouts: config.hermesTimeouts, transport: { kind: "direct", send(path, init, kind) {
    const rootPath = path.replace(/^\/p\/[^/]+(?=\/)/, "");
    if (rootPath.startsWith("/hermes-setup/")) {
      throw new HermesClientError("Les capacités de cet accès direct se gèrent sur l’hôte.", 403, "HERMES_LINK_PATH_FORBIDDEN");
    }
    return direct.send(rootPath, init, kind);
  } } };
}
