import { createPublicKey, randomBytes, verify } from "node:crypto";
import type { ApiConfig } from "@openedbot/platform-config/api-config";
import { RUNTIME_LINK_WS_PATH } from "../domain/ws-path";

/**
 * Preuve de possession du lien connecteur (OHB-54 côté hôte, OHB-56 ici).
 *
 * À l'enrôlement l'hôte génère une paire Ed25519 dont la clé privée reste
 * dans un credential systemd chiffré ; la clé publique est enregistrée avec
 * le runtime (`runtimes.link_device_pubkey`). À chaque session, juste après
 * `hello` et avant la liaison, le broker envoie `link.challenge {nonce}` et
 * attend `link.proof {signature}` :
 *
 *   message = "ohb-link-pop/v1\n" || nonce || "\n" || runtimeId || "\n" || wsURL || "\n"
 *
 * `wsURL` est l'URL que le connecteur a réellement dialée : la signature lie
 * la session à CE serveur, un relais qui rejouerait le défi vers un autre
 * openedbot ne produit rien d'utilisable. Le serveur reconstruit les formes qu'il
 * accepte depuis `API_PUBLIC_URL` ; hors production, le tunnel de
 * développement (`ws://127.0.0.1:<port>`) est accepté aussi.
 */
export const LINK_POP_PREFIX = "ohb-link-pop/v1";
export const LINK_POP_NONCE_BYTES = 32;
/** `link.proof` doit arriver vite : au-delà, la montée est refusée 4401. */
export const LINK_POP_TIMEOUT_MS = 10_000;

const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_64 = /^[A-Za-z0-9+/]{86}==$/;
/** En-tête SubjectPublicKeyInfo d'une clé Ed25519 : ce qui précède les 32 octets bruts. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function linkPopNonce(random: (size: number) => Buffer = randomBytes): string {
  return random(LINK_POP_NONCE_BYTES).toString("base64");
}

/** Les octets exacts que l'hôte signe. */
export function linkPopMessage(nonce: string, runtimeId: string, wsUrl: string): Uint8Array {
  const nonceBytes = Buffer.from(nonce, "base64");
  return Buffer.concat([
    Buffer.from(`${LINK_POP_PREFIX}\n`, "utf8"),
    nonceBytes,
    Buffer.from(`\n${runtimeId}\n${wsUrl}\n`, "utf8"),
  ]);
}

/**
 * Les URL WebSocket qu'une preuve peut nommer, dans l'ordre d'essai. En
 * production : l'origine publique (`wss://`), puis les anciennes origines
 * publiques encore acceptées pendant un changement de nom. Ailleurs : la même,
 * plus la forme loopback du tunnel de développement sur le port de l'API et
 * sur le port du tunnel par défaut (8790), et l'origine publique en `ws://`
 * quand elle n'est pas HTTPS (poste sans TLS).
 */
export function expectedLinkWsUrls(
  config: Pick<ApiConfig, "environment" | "publicUrl" | "port"> & Partial<Pick<ApiConfig, "linkPublicUrl" | "linkLegacyPublicUrls">>,
): string[] {
  const urls: string[] = [];
  const push = (value: string) => { if (!urls.includes(value)) urls.push(value); };
  // L'origine du lien d'abord (RUNTIME_LINK_PUBLIC_URL), puis l'origine publique
  // de l'API, que les hôtes déjà appairés composent tant qu'ils n'ont pas suivi
  // le nouveau nom, puis les anciennes (RUNTIME_LINK_LEGACY_PUBLIC_URLS).
  for (const publicUrl of [config.linkPublicUrl ?? config.publicUrl, config.publicUrl, ...(config.linkLegacyPublicUrls ?? [])]) {
    let origin: URL | null = null;
    try { origin = new URL(publicUrl); } catch { origin = null; }
    if (!origin) continue;
    const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
    if (scheme === "wss:" || config.environment !== "production") push(`${scheme}//${origin.host}${RUNTIME_LINK_WS_PATH}`);
  }
  if (config.environment !== "production") {
    push(`ws://127.0.0.1:${config.port}${RUNTIME_LINK_WS_PATH}`);
    push(`ws://127.0.0.1:8790${RUNTIME_LINK_WS_PATH}`);
    push(`ws://localhost:${config.port}${RUNTIME_LINK_WS_PATH}`);
  }
  return urls;
}

/**
 * Hors production, l'URL du tunnel de développement que CETTE montée a
 * composée, lue sur son en-tête `Host` : `ws://127.0.0.1:<port>`, ou rien.
 *
 * `make link-dev-up` donne à chaque poste son propre port de loopback sur le
 * VPS (8822 pour l'un, 8835 pour l'autre) pour que plusieurs postes restent
 * reliés au même VPS ; le connecteur signe le port qu'il compose, et la liste
 * fixe ci-dessus ne connaît que 8790. Seule la loopback IPv4 est lue, et
 * jamais en production : là, seule l'origine publique fait foi.
 */
/**
 * HTTPS (or dev HTTP) origin of a signed `ws`/`wss` URL. Path, query and
 * userinfo are dropped: the column stores the name the host dials, nothing else.
 */
export function linkSignedOrigin(wsUrl: string): string | null {
  let url: URL;
  try { url = new URL(wsUrl); } catch { return null; }
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  else return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** Public origins a proof may name, as `https://host` (the link origin first). */
export function acceptedLinkOrigins(
  config: Pick<ApiConfig, "publicUrl"> & Partial<Pick<ApiConfig, "linkPublicUrl" | "linkLegacyPublicUrls">>,
): string[] {
  const origins: string[] = [];
  for (const value of [config.linkPublicUrl ?? config.publicUrl, config.publicUrl, ...(config.linkLegacyPublicUrls ?? [])]) {
    try {
      const origin = new URL(value).origin;
      if (!origins.includes(origin)) origins.push(origin);
    } catch { /* a bad configured URL is ignored, as in expectedLinkWsUrls */ }
  }
  return origins;
}

/**
 * True when the host's last signed origin is no longer one this deployment
 * accepts. A development loopback is never retired: each workstation dials
 * its own `http://127.0.0.1:<port>`.
 */
export function isRetiredLinkOrigin(
  origin: string,
  publication: { environment: ApiConfig["environment"]; acceptedOrigins: readonly string[] },
): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return publication.environment === "production"; }
  if (publication.environment !== "production" && url.protocol === "http:") {
    const host = url.hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return false;
  }
  return !publication.acceptedOrigins.includes(url.origin);
}

export function devTunnelWsUrl(config: Pick<ApiConfig, "environment">, host: string | null): string | null {
  if (config.environment === "production" || !host) return null;
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(host.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? `ws://127.0.0.1:${port}${RUNTIME_LINK_WS_PATH}` : null;
}

/** Une clé publique Ed25519 en base64 standard de 32 octets, ou rien. */
export function isDevicePublicKey(value: unknown): value is string {
  return typeof value === "string" && BASE64_32.test(value);
}

/**
 * Vérifie une preuve contre chaque URL acceptée ; rend l'URL qui a signé, ou
 * `null`. Une clé ou une signature mal formée vaut un refus, jamais une
 * exception qui remonterait au socket.
 */
export function verifyLinkProof(input: {
  devicePublicKey: string;
  nonce: string;
  runtimeId: string;
  signature: string;
  wsUrls: readonly string[];
}): string | null {
  if (!BASE64_32.test(input.devicePublicKey) || !BASE64_32.test(input.nonce) || !BASE64_64.test(input.signature)) return null;
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.devicePublicKey, "base64")]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
  const signature = Buffer.from(input.signature, "base64");
  for (const wsUrl of input.wsUrls) {
    try {
      if (verify(null, linkPopMessage(input.nonce, input.runtimeId, wsUrl), publicKey, signature)) return wsUrl;
    } catch {
      return null;
    }
  }
  return null;
}
