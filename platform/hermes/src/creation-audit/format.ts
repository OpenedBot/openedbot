import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical";
import { verifyChain, type ChainVerdict } from "./chain";

/**
 * Le fichier `snapshot.bin` du connecteur, version 2 : contrat partagé avec
 * `edge-setup` (`internal/connector/audit_format.go`). Entiers big-endian :
 *
 *   0        8     magic "OHBAUDT2"
 *   8        1     version 0x02
 *   9        1     suite   0x01 = AES-256-GCM, HKDF-SHA256, SHA-256
 *   10       2     hlen
 *   12       hlen  en-tête JSON canonique {keyId,runtimeId,schemaVersion,writeSeq}
 *   12+hlen  12    nonce
 *   24+hlen  n     chiffré
 *   …        16    tag GCM
 *
 * Les données associées sont tous les octets qui précèdent le chiffré : un
 * en-tête ou un nonce retouché fait échouer le tag au lieu d'être cru.
 */
export const CREATION_AUDIT_MAGIC = "OHBAUDT2";
export const CREATION_AUDIT_VERSION = 0x02;
export const CREATION_AUDIT_SUITE_AES_GCM = 0x01;
export const CREATION_AUDIT_SCHEMA_VERSION = 2;
export const CREATION_AUDIT_MAX_HEADER = 1024;
export const CREATION_AUDIT_NONCE_SIZE = 12;
export const CREATION_AUDIT_TAG_SIZE = 16;
export const CREATION_AUDIT_KEY_SIZE = 32;
export const CREATION_AUDIT_INFO_ENC = "ohb-creation-audit/v2/enc";
/** Plafond du clair côté connecteur (8 MiB) ; le chiffré y ajoute l'en-tête, le nonce et le tag. */
export const CREATION_AUDIT_MAX_PLAINTEXT = 8 << 20;
/** Ce qu'un export peut peser au plus : le clair, l'en-tête, le nonce, le tag et une marge. */
export const CREATION_AUDIT_MAX_EXPORT_BYTES = CREATION_AUDIT_MAX_PLAINTEXT + (64 << 10);

export const CREATION_AUDIT_KEY_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

export type CreationAuditErrorCode =
  | "AUDIT_PLAINTEXT_EXPORT"
  | "AUDIT_FORMAT_INVALID"
  | "AUDIT_KEY_UNKNOWN"
  | "AUDIT_AUTH_FAILED"
  | "AUDIT_SEQ_MISMATCH"
  | "AUDIT_CHAIN_BROKEN";

export class CreationAuditError extends Error {
  constructor(readonly code: CreationAuditErrorCode, message: string) {
    super(message);
    this.name = "CreationAuditError";
  }
}

/** L'en-tête clair, lisible sans clé : il nomme la clé et le runtime. */
export type CreationAuditHeader = {
  keyId: string;
  runtimeId: string;
  schemaVersion: number;
  writeSeq: number;
};

export type CreationAuditEvent = {
  eventId: string;
  attemptId: string;
  phase: string;
  occurredAt: string;
  runtimeId: string;
  profile: string;
  correlationId: string;
  idempotencyKeyHash: string;
  method: string;
  path: string;
  status?: number;
  remoteId?: string;
  outcome?: string;
};

/** Le clair de `snapshot.bin`. */
export type CreationAuditSnapshot = {
  schemaVersion: number;
  startedAt: string;
  lastWrittenAt: string;
  runtimeId: string;
  writeSeq: number;
  count: number;
  dropped: number;
  base: string;
  tail: string;
  events: CreationAuditEvent[];
};

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Dérive la clé de chiffrement du fichier depuis la clé maîtresse que openedbot
 * remet au connecteur : `HKDF-SHA256(master, salt = runtimeId, info)`. Le
 * runtime est le sel, donc une même clé maîtresse ne scelle jamais le fichier
 * d'un autre runtime.
 */
export function deriveCreationAuditKey(master: Uint8Array, runtimeId: string): Uint8Array {
  if (master.byteLength !== CREATION_AUDIT_KEY_SIZE) throw new Error(`audit master key must be ${CREATION_AUDIT_KEY_SIZE} bytes`);
  if (!runtimeId) throw new Error("audit key derivation requires a runtime id");
  return new Uint8Array(hkdfSync("sha256", master, runtimeId, CREATION_AUDIT_INFO_ENC, CREATION_AUDIT_KEY_SIZE));
}

/**
 * Lit l'en-tête clair et rend l'offset du nonce. Un corps qui commence par
 * `{` est le `snapshot.json` en clair d'un connecteur antérieur : il n'est
 * jamais une preuve, et le dire explicitement vaut mieux qu'un « format
 * invalide » qui laisserait croire à un fichier abîmé.
 */
export function parseCreationAuditHeader(data: Uint8Array): { header: CreationAuditHeader; nonceAt: number } {
  if (data.byteLength > 0 && data[0] === 0x7b) {
    throw new CreationAuditError("AUDIT_PLAINTEXT_EXPORT", "Export en clair produit par un connecteur antérieur à l'audit v2 ; mettez à jour edge-setup puis exportez snapshot.bin.");
  }
  if (data.byteLength < 12 || decoder.decode(data.subarray(0, 8)) !== CREATION_AUDIT_MAGIC) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "Le fichier n'a pas l'en-tête d'un audit de création scellé.");
  }
  if (data[8] !== CREATION_AUDIT_VERSION || data[9] !== CREATION_AUDIT_SUITE_AES_GCM) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", `Version ${data[8]} ou suite ${data[9]} inconnue.`);
  }
  const hlen = (data[10]! << 8) | data[11]!;
  if (hlen === 0 || hlen > CREATION_AUDIT_MAX_HEADER || data.byteLength < 12 + hlen + CREATION_AUDIT_NONCE_SIZE + CREATION_AUDIT_TAG_SIZE) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", `Longueur d'en-tête ${hlen} invalide.`);
  }
  const headerBytes = data.subarray(12, 12 + hlen);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(headerBytes));
  } catch {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "L'en-tête n'est pas du JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "L'en-tête n'est pas un objet.");
  }
  const header = parsed as Record<string, unknown>;
  const keyId = header.keyId;
  const runtimeId = header.runtimeId;
  const schemaVersion = header.schemaVersion;
  const writeSeq = header.writeSeq ?? 0;
  if (typeof keyId !== "string" || !CREATION_AUDIT_KEY_ID_PATTERN.test(keyId) || typeof runtimeId !== "string" || !runtimeId
    || schemaVersion !== CREATION_AUDIT_SCHEMA_VERSION || typeof writeSeq !== "number" || !Number.isSafeInteger(writeSeq) || writeSeq < 0) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "Champs d'en-tête invalides.");
  }
  // Côté Go l'en-tête n'a pas d'`omitempty` : `writeSeq` y figure toujours.
  const canonical = canonicalJson({ keyId, runtimeId, schemaVersion, writeSeq });
  if (!bytesEqual(canonical, headerBytes)) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "L'en-tête n'est pas canonique.");
  }
  return { header: { keyId, runtimeId, schemaVersion, writeSeq }, nonceAt: 12 + hlen };
}

export type OpenedCreationAudit = {
  header: CreationAuditHeader;
  snapshot: CreationAuditSnapshot;
  chain: ChainVerdict;
};

/**
 * Authentifie et déchiffre un export. `keyFor` rend la clé MAÎTRESSE du
 * `keyId` nommé par l'en-tête ; la dérivation se fait ici avec le runtime de
 * l'en-tête, que le tag couvre. Le `writeSeq` de l'en-tête et du clair
 * doivent concorder, et la chaîne est recalculée depuis `base`.
 */
export function openCreationAudit(data: Uint8Array, keyFor: (keyId: string) => Uint8Array | null): OpenedCreationAudit {
  const { header, nonceAt } = parseCreationAuditHeader(data);
  const master = keyFor(header.keyId);
  if (!master) throw new CreationAuditError("AUDIT_KEY_UNKNOWN", `La clé ${header.keyId} n'est pas connue pour ce runtime.`);
  const key = deriveCreationAuditKey(master, header.runtimeId);
  const nonce = data.subarray(nonceAt, nonceAt + CREATION_AUDIT_NONCE_SIZE);
  const ciphertext = data.subarray(nonceAt + CREATION_AUDIT_NONCE_SIZE, data.byteLength - CREATION_AUDIT_TAG_SIZE);
  const tag = data.subarray(data.byteLength - CREATION_AUDIT_TAG_SIZE);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: CREATION_AUDIT_TAG_SIZE });
    decipher.setAAD(data.subarray(0, nonceAt + CREATION_AUDIT_NONCE_SIZE));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new CreationAuditError("AUDIT_AUTH_FAILED", "Le tag d'authentification est invalide : fichier modifié ou mauvaise clé.");
  }
  const snapshot = parseSnapshot(plaintext);
  if (snapshot.runtimeId !== header.runtimeId || snapshot.writeSeq !== header.writeSeq) {
    throw new CreationAuditError("AUDIT_SEQ_MISMATCH", "L'en-tête et le clair ne décrivent pas la même écriture.");
  }
  const chain = verifyChain(snapshot);
  if (!chain.ok) throw new CreationAuditError("AUDIT_CHAIN_BROKEN", `La chaîne d'événements est rompue (${chain.reason}).`);
  return { header, snapshot, chain };
}

/**
 * Scelle un clair sous une clé maîtresse : ce que le connecteur fait à chaque
 * écriture. Sert aux tests et aux fixtures ; l'API ne scelle jamais un audit
 * en production, elle n'en ouvre.
 */
export function sealCreationAudit(
  header: CreationAuditHeader,
  snapshot: CreationAuditSnapshot,
  master: Uint8Array,
  nonce: Uint8Array = randomBytes(CREATION_AUDIT_NONCE_SIZE),
): Uint8Array {
  const headerBytes = canonicalJson({
    keyId: header.keyId, runtimeId: header.runtimeId, schemaVersion: header.schemaVersion, writeSeq: header.writeSeq,
  });
  if (headerBytes.byteLength > CREATION_AUDIT_MAX_HEADER) throw new Error("audit header too long");
  if (nonce.byteLength !== CREATION_AUDIT_NONCE_SIZE) throw new Error("audit nonce must be 12 bytes");
  const key = deriveCreationAuditKey(master, header.runtimeId);
  const prefix = new Uint8Array(12 + headerBytes.byteLength + CREATION_AUDIT_NONCE_SIZE);
  prefix.set(new TextEncoder().encode(CREATION_AUDIT_MAGIC), 0);
  prefix[8] = CREATION_AUDIT_VERSION;
  prefix[9] = CREATION_AUDIT_SUITE_AES_GCM;
  prefix[10] = headerBytes.byteLength >> 8;
  prefix[11] = headerBytes.byteLength & 0xff;
  prefix.set(headerBytes, 12);
  prefix.set(nonce, 12 + headerBytes.byteLength);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: CREATION_AUDIT_TAG_SIZE });
  cipher.setAAD(prefix);
  const plaintext = canonicalJson(snapshotForWire(snapshot));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = new Uint8Array(prefix.byteLength + ciphertext.byteLength + tag.byteLength);
  out.set(prefix, 0);
  out.set(ciphertext, prefix.byteLength);
  out.set(tag, prefix.byteLength + ciphertext.byteLength);
  return out;
}

/**
 * Le clair tel que Go le sérialise : tous les champs du snapshot sont présents
 * (pas d'`omitempty`), seuls `status`, `remoteId` et `outcome` d'un
 * événement sont omis quand ils sont vides.
 */
function snapshotForWire(snapshot: CreationAuditSnapshot): Record<string, unknown> {
  return {
    schemaVersion: snapshot.schemaVersion,
    startedAt: snapshot.startedAt,
    lastWrittenAt: snapshot.lastWrittenAt,
    runtimeId: snapshot.runtimeId,
    writeSeq: snapshot.writeSeq,
    count: snapshot.count,
    dropped: snapshot.dropped,
    base: snapshot.base,
    tail: snapshot.tail,
    events: snapshot.events.map(eventForWire),
  };
}

function eventForWire(event: CreationAuditEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    eventId: event.eventId, attemptId: event.attemptId, phase: event.phase, occurredAt: event.occurredAt,
    runtimeId: event.runtimeId, profile: event.profile, correlationId: event.correlationId,
    idempotencyKeyHash: event.idempotencyKeyHash, method: event.method, path: event.path,
  };
  if (event.status) out.status = event.status;
  if (event.remoteId) out.remoteId = event.remoteId;
  if (event.outcome) out.outcome = event.outcome;
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;

function parseSnapshot(plaintext: Uint8Array): CreationAuditSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "Le clair n'est pas du JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "Le clair n'est pas un objet.");
  }
  const raw = parsed as Record<string, unknown>;
  const events = raw.events;
  if (raw.schemaVersion !== CREATION_AUDIT_SCHEMA_VERSION || typeof raw.runtimeId !== "string" || !raw.runtimeId
    || typeof raw.startedAt !== "string" || typeof raw.lastWrittenAt !== "string" || !Array.isArray(events)
    || typeof raw.base !== "string" || !HEX64.test(raw.base) || typeof raw.tail !== "string" || !HEX64.test(raw.tail)) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "Champs du clair invalides.");
  }
  const writeSeq = requiredCount(raw.writeSeq);
  const count = requiredCount(raw.count);
  const dropped = requiredCount(raw.dropped);
  if (writeSeq === null || count === null || dropped === null) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "Compteurs du clair invalides.");
  }
  return {
    schemaVersion: CREATION_AUDIT_SCHEMA_VERSION,
    startedAt: raw.startedAt,
    lastWrittenAt: raw.lastWrittenAt,
    runtimeId: raw.runtimeId,
    writeSeq,
    count,
    dropped,
    base: raw.base,
    tail: raw.tail,
    events: events.map(parseEvent),
  };
}

function requiredCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function parseEvent(value: unknown): CreationAuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CreationAuditError("AUDIT_FORMAT_INVALID", "Un événement n'est pas un objet.");
  }
  const raw = value as Record<string, unknown>;
  const text = (key: string): string => {
    const entry = raw[key];
    if (typeof entry !== "string") throw new CreationAuditError("AUDIT_FORMAT_INVALID", `Événement sans ${key}.`);
    return entry;
  };
  const event: CreationAuditEvent = {
    eventId: text("eventId"), attemptId: text("attemptId"), phase: text("phase"), occurredAt: text("occurredAt"),
    runtimeId: text("runtimeId"), profile: text("profile"), correlationId: text("correlationId"),
    idempotencyKeyHash: text("idempotencyKeyHash"), method: text("method"), path: text("path"),
  };
  if (raw.status !== undefined) {
    if (typeof raw.status !== "number" || !Number.isSafeInteger(raw.status)) throw new CreationAuditError("AUDIT_FORMAT_INVALID", "Statut d'événement invalide.");
    event.status = raw.status;
  }
  if (raw.remoteId !== undefined) event.remoteId = text("remoteId");
  if (raw.outcome !== undefined) event.outcome = text("outcome");
  return event;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
