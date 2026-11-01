export type VapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

const URL_SAFE_BASE64 = /^[A-Za-z0-9_-]+$/;

/**
 * Lit les trois variables VAPID. Absentes toutes les trois : `null` (la
 * fonctionnalité est éteinte). Présentes partiellement, ou mal formées : erreur :
 * un demi-réglage n'est pas un push désactivé, c'est une panne de config.
 */
export function readVapidConfig(
  env: Record<string, string | undefined>,
  required: boolean,
): VapidConfig | null {
  const publicKey = env.PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.PUSH_VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.PUSH_VAPID_SUBJECT?.trim() ?? "";
  const present = [publicKey, privateKey, subject].filter(Boolean).length;
  if (present === 0) {
    if (required) throw new Error("PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY and PUSH_VAPID_SUBJECT are required in production.");
    return null;
  }
  if (present !== 3) {
    throw new Error("PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY and PUSH_VAPID_SUBJECT must be set together.");
  }
  return parseVapidConfig({ publicKey, privateKey, subject });
}

export function parseVapidConfig(input: VapidConfig): VapidConfig {
  const publicKey = decodeUrlSafeBase64(input.publicKey, "PUSH_VAPID_PUBLIC_KEY");
  if (publicKey.byteLength !== 65 || publicKey[0] !== 0x04) {
    throw new Error("PUSH_VAPID_PUBLIC_KEY must be an uncompressed P-256 point (65 bytes, 0x04 prefix) in URL-safe base64.");
  }
  const privateKey = decodeUrlSafeBase64(input.privateKey, "PUSH_VAPID_PRIVATE_KEY");
  if (privateKey.byteLength !== 32) {
    throw new Error("PUSH_VAPID_PRIVATE_KEY must be 32 bytes in URL-safe base64.");
  }
  if (!isVapidSubject(input.subject)) {
    throw new Error("PUSH_VAPID_SUBJECT must be a mailto: or https: URI.");
  }
  return {
    publicKey: input.publicKey.trim(),
    privateKey: input.privateKey.trim(),
    subject: input.subject.trim(),
  };
}

export function isVapidSubject(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "mailto:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeUrlSafeBase64(value: string, name: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed || !URL_SAFE_BASE64.test(trimmed) || trimmed.length > 256) {
    throw new Error(`${name} must be URL-safe base64.`);
  }
  const padded = trimmed.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (trimmed.length % 4)) % 4);
  try {
    return Uint8Array.from(Buffer.from(padded, "base64"));
  } catch {
    throw new Error(`${name} must be URL-safe base64.`);
  }
}
