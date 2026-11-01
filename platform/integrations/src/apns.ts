import { createPrivateKey, type KeyObject } from "node:crypto";

/** Apple Push Notification service origins, chosen per device environment. */
export const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com";
export const APNS_SANDBOX_ORIGIN = "https://api.sandbox.push.apple.com";

export type ApnsEnvironment = "sandbox" | "production";

export type ApnsConfig = {
  /** 10-character key identifier of the `.p8` signing key (`kid` of the JWT). */
  keyId: string;
  /** 10-character Apple Developer team identifier (`iss` of the JWT). */
  teamId: string;
  /** EC P-256 private key parsed once at boot; never serialized or logged. */
  privateKey: KeyObject;
  /** Bundle identifiers a device may register with; each is also an `apns-topic`. */
  bundleIds: readonly string[];
  /**
   * Single origin replacing both Apple hosts (local fake APNs). Refused in
   * production; `http:` only toward a loopback host.
   */
  hostOverride: string | null;
};

const APPLE_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Reads the APNs variables. All four absent: `null`, the feature is off and
 * `GET /api/push/apns/config` says so. Partially set or malformed: an error at
 * boot; a half configuration is a configuration fault, not a disabled feature.
 * Never required, production included: iOS push is optional for a deployment.
 */
export function readApnsConfig(
  env: Record<string, string | undefined>,
  production: boolean,
): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim() ?? "";
  const teamId = env.APNS_TEAM_ID?.trim() ?? "";
  const privateKey = env.APNS_PRIVATE_KEY?.trim() ?? "";
  const bundleIds = env.APNS_BUNDLE_IDS?.trim() ?? "";
  const hostOverride = env.APNS_HOST_OVERRIDE?.trim() ?? "";
  const present = [keyId, teamId, privateKey, bundleIds].filter(Boolean).length;
  if (present === 0) {
    if (hostOverride) throw new Error("APNS_HOST_OVERRIDE requires APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY and APNS_BUNDLE_IDS.");
    return null;
  }
  if (present !== 4) {
    throw new Error("APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY and APNS_BUNDLE_IDS must be set together.");
  }
  if (!APPLE_ID.test(keyId)) throw new Error("APNS_KEY_ID must be the 10-character key identifier (A-Z, 0-9).");
  if (!APPLE_ID.test(teamId)) throw new Error("APNS_TEAM_ID must be the 10-character team identifier (A-Z, 0-9).");
  return {
    keyId,
    teamId,
    privateKey: parseApnsPrivateKey(privateKey),
    bundleIds: parseBundleIds(bundleIds),
    hostOverride: hostOverride ? parseHostOverride(hostOverride, production) : null,
  };
}

/** The origin a delivery goes to: the override when set, else Apple's host for the device environment. */
export function apnsOrigin(config: Pick<ApnsConfig, "hostOverride">, environment: ApnsEnvironment): string {
  if (config.hostOverride) return config.hostOverride;
  return environment === "production" ? APNS_PRODUCTION_ORIGIN : APNS_SANDBOX_ORIGIN;
}

/**
 * Accepts the `.p8` file content (PEM, real newlines or `\n` escapes, which a
 * one-line secret manager value often carries) or its base64 PKCS#8 DER body.
 * Only an EC P-256 key signs ES256.
 */
export function parseApnsPrivateKey(value: string): KeyObject {
  const text = value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
  let key: KeyObject;
  try {
    key = text.includes("-----BEGIN")
      ? createPrivateKey({ key: text, format: "pem" })
      : createPrivateKey({ key: Buffer.from(text.replace(/\s+/g, ""), "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("APNS_PRIVATE_KEY must be the .p8 key (PKCS#8 PEM or its base64 body).");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("APNS_PRIVATE_KEY must be an EC P-256 key (ES256).");
  }
  return key;
}

function parseBundleIds(value: string): string[] {
  const ids = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("APNS_BUNDLE_IDS must list at least one bundle identifier.");
  for (const id of ids) {
    if (id.length > 255 || !BUNDLE_ID.test(id)) {
      throw new Error("APNS_BUNDLE_IDS must be comma-separated reverse-DNS bundle identifiers.");
    }
  }
  return ids;
}

function parseHostOverride(value: string, production: boolean): string {
  if (production) throw new Error("APNS_HOST_OVERRIDE is refused in production: deliveries go to Apple only.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APNS_HOST_OVERRIDE must be an origin URL such as http://127.0.0.1:18793.");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("APNS_HOST_OVERRIDE must be a bare origin, without credentials, path or query.");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("APNS_HOST_OVERRIDE may use http: only toward a loopback host.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("APNS_HOST_OVERRIDE must use http: (loopback) or https:.");
  }
  return url.origin;
}
