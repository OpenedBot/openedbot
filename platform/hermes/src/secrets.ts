import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EncryptedSecret = {
  ciphertext: string;
  nonce: string;
  tag: string;
};

export type SecretEncryptionKey = {
  id: string;
  value: Uint8Array;
};

export type SecretKeyring = {
  current: SecretEncryptionKey;
  previous: readonly SecretEncryptionKey[];
};

export type DecryptedSecret = {
  value: string;
  keyId: string;
  needsRotation: boolean;
};

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

export function secretEncryptionKey(value: Uint8Array): SecretEncryptionKey {
  if (value.byteLength !== 32) throw new Error("Secret encryption keys must be exactly 32 bytes.");
  return {
    id: createHash("sha256").update(value).digest("base64url"),
    value,
  };
}

export function encryptSecret(value: string, key: Uint8Array): EncryptedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(value: EncryptedSecret, key: Uint8Array): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function decryptSecretFromKeyring(
  secret: EncryptedSecret,
  encryptedWithKeyId: string | null,
  keyring: SecretKeyring,
): DecryptedSecret {
  const keys = uniqueKeys([keyring.current, ...keyring.previous]);
  const candidates = encryptedWithKeyId
    ? keys.filter((key) => key.id === encryptedWithKeyId)
    : keys;

  if (candidates.length === 0) {
    throw new SecretDecryptionError(`The encryption key ${encryptedWithKeyId} is not available.`);
  }

  for (const key of candidates) {
    try {
      return {
        value: decryptSecret(secret, key.value),
        keyId: key.id,
        needsRotation: key.id !== keyring.current.id,
      };
    } catch {
      // AES-GCM authentication failure: try the next explicitly configured legacy key.
    }
  }

  throw new SecretDecryptionError("The encrypted secret could not be authenticated with the configured keys.");
}

function uniqueKeys(keys: readonly SecretEncryptionKey[]): SecretEncryptionKey[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    if (seen.has(key.id)) return false;
    seen.add(key.id);
    return true;
  });
}
