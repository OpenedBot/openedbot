import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Les origines `hôte:port` autorisées en HTTP clair, uniquement en
 * développement. La liste vient de la configuration (`HERMES_ALLOW_INSECURE_ORIGINS`)
 * et non plus du code, pour qu'ajouter une machine locale ne demande pas de
 * republier le paquet.
 *
 * Elle reste EXPLICITE, jamais un motif : chaque entrée est un couple hôte+port
 * littéral. Un joker (`10.0.0.*`) ou un CIDR rouvrirait exactement le trou
 * que le garde SSRF ferme, puisque cette allowlist est le seul chemin qui
 * contourne `isForbiddenAddress`. Absente ou vide, aucune URL HTTP ne passe.
 */
export type EndpointPolicy = {
  environment: "development" | "test" | "production";
  /** Explicit local fake Hermes URL used only by deterministic tests/load runs. */
  testHttpUrl?: string;
  /** Explicit `host:port` origins allowed over cleartext HTTP in development. */
  insecureOrigins?: ReadonlySet<string>;
};

/**
 * Parse la valeur de configuration en origines exactes. Toute entrée qui n'est
 * pas un `hôte:port` littéral est refusée au démarrage plutôt qu'ignorée
 * silencieusement : une allowlist mal comprise doit faire échouer le processus,
 * pas élargir la surface.
 */
export function parseInsecureHermesOrigins(raw: string | undefined): ReadonlySet<string> {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const origins = new Set<string>();
  for (const entry of entries) {
    if (entry.includes("://")) {
      throw new HermesEndpointError(
        `HERMES_ALLOW_INSECURE_ORIGINS attend des entrées hôte:port, pas une URL : ${entry}`,
        "HERMES_URL_INVALID",
      );
    }
    if (entry.includes("*") || entry.includes("/")) {
      throw new HermesEndpointError(
        `HERMES_ALLOW_INSECURE_ORIGINS n’accepte ni joker ni CIDR : ${entry}`,
        "HERMES_URL_INVALID",
      );
    }
    let url: URL;
    try {
      url = new URL(`http://${entry}`);
    } catch {
      throw new HermesEndpointError(
        `HERMES_ALLOW_INSECURE_ORIGINS attend des entrées hôte:port : ${entry}`,
        "HERMES_URL_INVALID",
      );
    }
    if (url.host !== entry || url.port === "" || url.username || url.password) {
      throw new HermesEndpointError(
        `HERMES_ALLOW_INSECURE_ORIGINS attend des entrées hôte:port : ${entry}`,
        "HERMES_URL_INVALID",
      );
    }
    origins.add(url.host);
  }
  return origins;
}

export type ResolvedHermesDestination = {
  /** Endpoint normalized by the same policy used for validation. */
  endpoint: string;
  /** Original hostname, kept for HTTP Host and TLS SNI/certificate checks. */
  hostname: string;
  /** Address selected from the validated DNS answer. Null only for an explicit HTTP test/lab allowlist. */
  address: string | null;
  family: 4 | 6 | null;
};

export type PinnedHermesRequest = {
  url: string;
  hostHeader: string | null;
  tlsServerName: string | null;
};

export class HermesEndpointError extends Error {
  constructor(
    message: string,
    readonly code:
      | "HERMES_URL_INVALID"
      | "HERMES_HTTPS_REQUIRED"
      | "HERMES_DESTINATION_FORBIDDEN"
      | "HERMES_DNS_FAILED",
  ) {
    super(message);
    this.name = "HermesEndpointError";
  }
}

export function normalizeHermesEndpoint(raw: string, policy: EndpointPolicy): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HermesEndpointError("L’URL Hermes est invalide.", "HERMES_URL_INVALID");
  }

  if (url.hostname.toLowerCase().replace(/\.$/, "").endsWith(".trycloudflare.com")) {
    const error = new HermesEndpointError("Tunnel nommé requis : créez un tunnel nommé à l’étape 1.", "HERMES_URL_INVALID");
    error.name = "RUNTIME_QUICK_TUNNEL_REFUSED";
    throw error;
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new HermesEndpointError(
      "L’URL Hermes ne doit contenir ni identifiants, ni paramètres, ni fragment.",
      "HERMES_URL_INVALID",
    );
  }

  const normalized = url.toString().replace(/\/+$/, "");
  const allowedDevelopmentHttp = isInsecureOriginAllowed(url, policy);
  const allowedTestHttp =
    policy.environment === "test" &&
    typeof policy.testHttpUrl === "string" &&
    normalized === normalizeTestHttpUrl(policy.testHttpUrl);

  if (url.protocol !== "https:" && !allowedDevelopmentHttp && !allowedTestHttp) {
    throw new HermesEndpointError(
      "Hermes doit être exposé en HTTPS. Seules les origines de développement explicitement déclarées acceptent HTTP.",
      "HERMES_HTTPS_REQUIRED",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HermesEndpointError("Le protocole Hermes est invalide.", "HERMES_URL_INVALID");
  }

  return normalized;
}

/** Resolve and validate once so the transport can dial that exact address. */
export async function resolveHermesDestination(
  endpoint: string,
  policy: EndpointPolicy,
): Promise<ResolvedHermesDestination> {
  const normalized = normalizeHermesEndpoint(endpoint, policy);
  const hostname = unbracketHostname(new URL(normalized).hostname);
  if (isExplicitHttpAllowlisted(normalized, policy)) {
    return { endpoint: normalized, hostname, address: null, family: null };
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isForbiddenAddress(hostname)) throwForbiddenDestination();
    return {
      endpoint: normalized,
      hostname,
      address: hostname,
      family: literalFamily === 4 ? 4 : 6,
    };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HermesEndpointError(
      "Le nom DNS du runtime Hermes ne peut pas être résolu.",
      "HERMES_DNS_FAILED",
    );
  }

  if (addresses.length === 0 || addresses.some(({ address }) => isForbiddenAddress(address))) {
    throwForbiddenDestination();
  }

  const selected = addresses[0]!;
  if (selected.family !== 4 && selected.family !== 6) {
    throw new HermesEndpointError(
      "Le nom DNS du runtime Hermes a renvoyé une famille d’adresse invalide.",
      "HERMES_DNS_FAILED",
    );
  }
  return {
    endpoint: normalized,
    hostname,
    address: selected.address,
    family: selected.family,
  };
}

/** Backward-compatible validation-only facade. */
export async function assertHermesDestination(
  endpoint: string,
  policy: EndpointPolicy,
): Promise<void> {
  await resolveHermesDestination(endpoint, policy);
}

/**
 * Rewrites an HTTPS request to the already validated IP address. `Host` and
 * TLS server name stay bound to the original hostname, so the transport does
 * not perform a second, attacker-controlled DNS lookup after validation.
 */
export function pinHermesRequestUrl(
  requestUrl: string,
  destination: ResolvedHermesDestination,
): PinnedHermesRequest {
  const url = new URL(requestUrl);
  if (
    url.protocol !== "https:" ||
    destination.address === null ||
    isIP(destination.hostname) !== 0
  ) {
    return { url: url.toString(), hostHeader: null, tlsServerName: null };
  }

  const hostHeader = url.host;
  url.hostname = destination.family === 6
    ? `[${destination.address}]`
    : destination.address;
  return {
    url: url.toString(),
    hostHeader,
    tlsServerName: destination.hostname,
  };
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Le seul chemin qui contourne le garde SSRF : une origine HTTP explicitement
 * déclarée, en développement uniquement. Le protocole est vérifié ici pour
 * qu'une origine déclarée ne puisse jamais élargir ce qui est accepté en HTTPS.
 */
function isInsecureOriginAllowed(url: URL, policy: EndpointPolicy): boolean {
  return (
    policy.environment === "development" &&
    url.protocol === "http:" &&
    (policy.insecureOrigins?.has(url.host) ?? false)
  );
}

function isExplicitHttpAllowlisted(endpoint: string, policy: EndpointPolicy): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (isInsecureOriginAllowed(url, policy)) return true;
  return policy.environment === "test" && typeof policy.testHttpUrl === "string"
    ? endpoint === normalizeTestHttpUrl(policy.testHttpUrl)
    : false;
}

function normalizeTestHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HermesEndpointError("TEST_HERMES_URL est invalide.", "HERMES_URL_INVALID");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) {
    throw new HermesEndpointError(
      "TEST_HERMES_URL doit être une URL HTTP locale sans identifiants ni paramètres.",
      "HERMES_URL_INVALID",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export function hermesProfileEndpoint(endpoint: string, slug: string): string {
  return `${endpoint.replace(/\/+$/, "")}${hermesProfilePath(slug)}`;
}

/**
 * Le préfixe `/p/<slug>` d'un profil Hermes, sans hôte : c'est le client qui
 * le pose devant chaque chemin, quel que soit le transport derrière.
 */
export function hermesProfilePath(slug: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(slug)) {
    throw new HermesEndpointError("Le slug du profil Hermes est invalide.", "HERMES_URL_INVALID");
  }
  return `/p/${encodeURIComponent(slug)}`;
}

/**
 * SSRF guard. Canonicalizes the address to raw bytes (4 for IPv4, 16 for IPv6)
 * and tests ranges on those bytes, never on the textual form. Comparing
 * strings is unsafe because the same address has many spellings: `::ffff:10.0.0.1`,
 * `::ffff:0a00:0001` (hex) and `0:0:0:0:0:ffff:10.0.0.1` (uncompressed) all denote
 * one IPv4-mapped address. Any embedded IPv4 (mapped, NAT64, 6to4) is extracted and
 * checked against the IPv4 rules. Parse failure defaults to forbidden.
 */
export function isForbiddenAddress(input: string): boolean {
  const address = (input.toLowerCase().split("%")[0] ?? "").trim();
  const family = isIP(address);
  if (family === 4) {
    const octets = parseIpv4(address);
    return octets === null ? true : isForbiddenIpv4(octets);
  }
  if (family === 6) {
    const bytes = parseIpv6(address);
    if (bytes === null) return true;
    return isForbiddenIpv6(bytes);
  }
  return true;
}

function isForbiddenIpv4(octets: readonly number[]): boolean {
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local + cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    a >= 224 // multicast + reserved
  );
}

function isForbiddenIpv6(bytes: readonly number[]): boolean {
  // Embedded IPv4: mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16.
  const embedded = embeddedIpv4(bytes);
  if (embedded) return isForbiddenIpv4(embedded);

  const allZero = bytes.every((byte) => byte === 0);
  if (allZero) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // ULA fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (bytes[0] === 0xff) return true; // multicast ff00::/8
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32
  return false;
}

function embeddedIpv4(bytes: readonly number[]): number[] | null {
  const isZero = (from: number, to: number): boolean => bytes.slice(from, to).every((byte) => byte === 0);
  // IPv4-mapped ::ffff:a.b.c.d
  if (isZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12, 16);
  // NAT64 well-known prefix 64:ff9b::/96
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && isZero(4, 12)) {
    return bytes.slice(12, 16);
  }
  // 6to4 2002:V4::/16
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6);
  return null;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/** Expands any valid IPv6 spelling (compressed, uncompressed, IPv4-tailed) to 16 bytes. */
function parseIpv6(address: string): number[] | null {
  const [head, tail, ...rest] = address.split("::");
  if (rest.length > 0) return null; // more than one "::"

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    const tokens = segment.split(":");
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      // A trailing dotted-quad occupies the final two groups (four bytes).
      if (token.includes(".")) {
        if (index !== tokens.length - 1) return null;
        const v4 = parseIpv4(token);
        if (v4 === null) return null;
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  const headGroups = parseGroups(head ?? "");
  if (headGroups === null) return null;
  const tailGroups = tail === undefined ? null : parseGroups(tail);
  if (tail !== undefined && tailGroups === null) return null;

  let groups: number[];
  if (tail === undefined) {
    if (headGroups.length !== 8) return null; // no "::" → must be full
    groups = headGroups;
  } else {
    const fill = 8 - headGroups.length - (tailGroups?.length ?? 0);
    if (fill < 0) return null;
    groups = [...headGroups, ...Array<number>(fill).fill(0), ...(tailGroups ?? [])];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
  return bytes;
}

function throwForbiddenDestination(): never {
  throw new HermesEndpointError(
    "Le runtime Hermes résout vers une destination privée, locale ou réservée.",
    "HERMES_DESTINATION_FORBIDDEN",
  );
}
