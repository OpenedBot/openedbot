/**
 * Le bail YOLO, domaine pur : forme canonique, message signé, signature et
 * vérification Ed25519, validation. Aucune clé n'est lue ici : elles sont
 * passées en paramètres (la clé de signature du cloud arrive en PR 2,
 * l'épinglage côté hôte en PR 3). `now` est toujours injecté.
 *
 * Message signé : `"ohb-yolo-lease/v1\n" || canonical(lease)`, où
 * `canonical` est le JSON canonique de l'audit de création
 * (`@openedbot/hermes`, identique octet pour octet à `canonicalJSON` de
 * `audit_format.go`) : l'hôte Go revérifie la même suite d'octets. Le
 * vecteur `yolo-lease/lease-v1.json` (graine de TEST publique) tient les deux
 * côtés.
 *
 * La signature protège contre la falsification locale d'un bail et son
 * rejeu (pierres tombales, `killedAt`) ; pas contre un cloud compromis.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { normalizeCommandBlocklist, YOLO_MAX_SECONDS } from "@openedbot/contracts-api";
import { parseYoloLease, RelayFrameError, YOLO_LEASE_SIGNING_PREFIX, type YoloLeaseV1 } from "@openedbot/contracts-connector";
import { canonicalJson } from "@openedbot/hermes";
import { isYoloProtectionId, YOLO_DEFAULT_PROTECT } from "./yolo-hardline";

/** Avance d'horloge tolérée sur `notBefore` (horloge de l'hôte en retard). Jamais sur `expiresAt`. */
export const YOLO_CLOCK_SKEW_SECONDS = 300;

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const encoder = new TextEncoder();

/** Une clé de signature de baux : la clé privée et ce qu'en épingle l'hôte. */
export type YoloSigningKey = { keyId: string; publicKey: string; privateKey: KeyObject };
/** Une clé publique épinglée par l'hôte : `publicKey` brute (32 octets) en base64. */
export type YoloPinnedKey = { keyId: string; publicKey: string };

export type YoloLeaseIssue =
  | "shape"
  | "key_unknown"
  | "signature_invalid"
  | "scope_mismatch"
  | "window_invalid"
  | "duration_exceeded"
  | "protect_unknown"
  | "protect_incomplete"
  | "deny_invalid"
  | "runtime_mismatch"
  | "not_yet_valid"
  | "expired"
  | "revoked"
  | "killed";

export type YoloLeaseCheck = { ok: true } | { ok: false; issue: YoloLeaseIssue };

/**
 * Le JSON canonique d'un bail, sur ses seuls champs v1 : une propriété en
 * trop sur l'objet en mémoire ne change pas ce qui est signé.
 */
export function canonicalYoloLease(lease: YoloLeaseV1): Uint8Array {
  return canonicalJson({
    v: lease.v,
    leaseId: lease.leaseId,
    organizationId: lease.organizationId,
    runtimeId: lease.runtimeId,
    scope: lease.scope,
    profile: lease.profile,
    sessionKey: lease.sessionKey,
    issuedAt: lease.issuedAt,
    notBefore: lease.notBefore,
    expiresAt: lease.expiresAt,
    grantedBy: lease.grantedBy,
    deny: { commands: lease.deny.commands, tools: lease.deny.tools, paths: lease.deny.paths },
    protect: lease.protect,
  });
}

/** Le message signé : préfixe de domaine puis forme canonique. */
export function yoloLeaseMessage(lease: YoloLeaseV1): Uint8Array {
  const prefix = encoder.encode(YOLO_LEASE_SIGNING_PREFIX);
  const body = canonicalYoloLease(lease);
  const message = new Uint8Array(prefix.byteLength + body.byteLength);
  message.set(prefix, 0);
  message.set(body, prefix.byteLength);
  return message;
}

/** `keyId` : les 16 premiers octets, en hex, de sha256(clé publique brute). */
export function yoloLeaseKeyId(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 32);
}

/** La clé de signature d'une graine Ed25519 de 32 octets. */
export function yoloSigningKeyFromSeed(seed: Uint8Array): YoloSigningKey {
  if (seed.byteLength !== 32) throw new Error("An Ed25519 seed is 32 bytes.");
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const publicKey = spki.subarray(ED25519_SPKI_PREFIX.byteLength).toString("base64");
  return { keyId: yoloLeaseKeyId(publicKey), publicKey, privateKey };
}

/** Signe un bail ; Ed25519 est déterministe, le même bail donne la même signature. */
export function signYoloLease(lease: YoloLeaseV1, key: YoloSigningKey): { keyId: string; signature: string } {
  return { keyId: key.keyId, signature: sign(null, yoloLeaseMessage(lease), key.privateKey).toString("base64") };
}

/** La signature, sur une clé épinglée seulement. */
export function verifyYoloLeaseSignature(
  lease: YoloLeaseV1,
  keyId: string,
  signature: string,
  pinnedKeys: readonly YoloPinnedKey[],
): YoloLeaseCheck {
  const pinned = pinnedKeys.find((key) => key.keyId === keyId);
  // A pinned entry whose id does not match its key is not a pin of this key.
  if (!pinned || yoloLeaseKeyId(pinned.publicKey) !== keyId) return { ok: false, issue: "key_unknown" };
  const raw = Buffer.from(pinned.publicKey, "base64");
  const bytes = Buffer.from(signature, "base64");
  if (raw.byteLength !== 32 || bytes.byteLength !== 64) return { ok: false, issue: "signature_invalid" };
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  return verify(null, yoloLeaseMessage(lease), key, bytes) ? { ok: true } : { ok: false, issue: "signature_invalid" };
}

/**
 * Ce que le bail dit de lui-même, sans horloge ni hôte : portée cohérente
 * avec `profile` / `sessionKey`, fenêtre ordonnée et bornée à 24 h,
 * protections connues et complètes, deny-list de commandes bien formée.
 */
export function validateYoloLeaseShape(lease: YoloLeaseV1): YoloLeaseCheck {
  const scoped = lease.scope === "thread" ? lease.profile !== null && lease.sessionKey !== null
    : lease.scope === "bot" ? lease.profile !== null && lease.sessionKey === null
      : lease.profile === null && lease.sessionKey === null;
  if (!scoped) return { ok: false, issue: "scope_mismatch" };
  if (lease.notBefore < lease.issuedAt || lease.expiresAt <= lease.notBefore) return { ok: false, issue: "window_invalid" };
  if (lease.expiresAt - lease.issuedAt > YOLO_MAX_SECONDS) return { ok: false, issue: "duration_exceeded" };
  if (!lease.protect.every(isYoloProtectionId)) return { ok: false, issue: "protect_unknown" };
  if (!YOLO_DEFAULT_PROTECT.every((id) => lease.protect.includes(id))) return { ok: false, issue: "protect_incomplete" };
  if (!normalizeCommandBlocklist(lease.deny.commands).ok) return { ok: false, issue: "deny_invalid" };
  return { ok: true };
}

export type YoloLeaseContext = {
  /** Secondes epoch, injectées. */
  now: number;
  /** Le runtime qui vérifie : un bail d'un autre runtime n'ouvre rien. */
  runtimeId: string;
  /** Baux révoqués localement (pierres tombales). */
  revokedLeaseIds?: ReadonlySet<string>;
  /** `edge-setup yolo off` : tout bail émis avant ou à cet instant est mort. */
  killedAt?: number | null;
};

/** Ce que le bail vaut ici et maintenant, une fois sa forme acceptée. */
export function validateYoloLease(lease: YoloLeaseV1, context: YoloLeaseContext): YoloLeaseCheck {
  const shape = validateYoloLeaseShape(lease);
  if (!shape.ok) return shape;
  if (lease.runtimeId !== context.runtimeId) return { ok: false, issue: "runtime_mismatch" };
  if (context.revokedLeaseIds?.has(lease.leaseId)) return { ok: false, issue: "revoked" };
  if (context.killedAt !== undefined && context.killedAt !== null && lease.issuedAt <= context.killedAt) return { ok: false, issue: "killed" };
  if (context.now < lease.notBefore - YOLO_CLOCK_SKEW_SECONDS) return { ok: false, issue: "not_yet_valid" };
  if (context.now >= lease.expiresAt) return { ok: false, issue: "expired" };
  return { ok: true };
}

/**
 * La vérification complète d'un bail reçu, dans l'ordre de l'hôte : forme
 * stricte, signature sur une clé épinglée, puis validité ici et maintenant.
 */
export function verifyYoloLease(
  received: { lease: unknown; keyId: string; signature: string },
  context: YoloLeaseContext & { pinnedKeys: readonly YoloPinnedKey[] },
): { ok: true; lease: YoloLeaseV1 } | { ok: false; issue: YoloLeaseIssue } {
  let lease: YoloLeaseV1;
  try {
    lease = parseYoloLease(received.lease);
  } catch (error) {
    if (error instanceof RelayFrameError) return { ok: false, issue: "shape" };
    throw error;
  }
  const signed = verifyYoloLeaseSignature(lease, received.keyId, received.signature, context.pinnedKeys);
  if (!signed.ok) return signed;
  const valid = validateYoloLease(lease, context);
  return valid.ok ? { ok: true, lease } : valid;
}
