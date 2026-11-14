import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "@openedbot/hermes";
import type { AuditVerdictSigningConfig } from "@openedbot/platform-config/api-config";

/**
 * Les verdicts d'audit de création sont signés Ed25519 par l'API : un verdict
 * conservé dans les artefacts d'une recette se revérifie hors ligne avec la
 * clé publique (`GET /api/creation-audit/verdict-key`), sans refaire
 * confiance à la base. Le message signé est le JSON canonique du verdict
 * (même canonicalisation que l'audit lui-même) ; `signatureKeyId` nomme la
 * clé pour qu'une rotation ne rende pas les anciens verdicts orphelins.
 */
export type VerdictSigner = {
  keyId: string;
  publicKey: string;
  ephemeral: boolean;
  sign(payload: Record<string, unknown>): { signature: string; signatureKeyId: string };
};

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.byteLength !== 32) throw new Error("An Ed25519 seed is 32 bytes.");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
}

/** La clé publique brute (32 octets, base64) d'une clé Ed25519. */
export function rawPublicKey(key: KeyObject): string {
  const spki = createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(ED25519_SPKI_PREFIX.byteLength).toString("base64");
}

export function createVerdictSigner(config: AuditVerdictSigningConfig): VerdictSigner {
  const privateKey = privateKeyFromSeed(config.seed);
  const publicKey = rawPublicKey(privateKey);
  const keyId = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("base64url").slice(0, 16);
  return {
    keyId,
    publicKey,
    ephemeral: config.ephemeral,
    sign(payload) {
      const signature = sign(null, canonicalJson(payload), privateKey).toString("base64");
      return { signature, signatureKeyId: keyId };
    },
  };
}

/** La vérification miroir, telle qu'un revalidateur hors API la rejoue. */
export function verifyVerdictSignature(payload: Record<string, unknown>, signature: string, publicKey: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });
    return verify(null, canonicalJson(payload), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
