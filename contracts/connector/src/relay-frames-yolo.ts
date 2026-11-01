/**
 * Trames du mode YOLO (bail de contournement des permissions) : le bail signé
 * que openedbot pousse une fois, sa révocation, l'état que l'hôte en tient et
 * l'audit local de ses auto-approbations. `decodeTextFrame` (`relay-frames.ts`)
 * délègue ici chaque type `yolo.*`.
 *
 * Mêmes règles que `DecodeText` côté Go (edge-setup,
 * `internal/connector/frames_yolo.go`) ; un hôte plus ancien les refuse comme
 * tout type inconnu, et openedbot ne les pousse qu'à un hôte qui annonce
 * `yolo_lease`. Les vecteurs sont dans les deux copies de `vectors.json`
 * (`relay-frames.vectors.json` ici), sous `make contract-check`.
 *
 * `link.context.leaseKeys` (les clés publiques que l'hôte épingle) est lu ici
 * aussi, en forme seulement : l'épinglage (premier usage, puis seulement une
 * clé endossée par une clé déjà épinglée) est la décision de l'hôte.
 *
 * Le bail n'est qu'une forme ici : sa signature, ses bornes de durée et la
 * cohérence de sa portée sont vérifiées par le domaine
 * (`modules/execution/src/domain/yolo-lease.ts`) et par l'hôte.
 */

import { isUuid } from "@openedbot/contracts-primitives";
import { RelayFrameError } from "./relay-frame-error";

/** Capacité de l'hôte : il vérifie et applique les baux YOLO hors ligne. */
export const RELAY_FEATURE_YOLO_LEASE = "yolo_lease";
/** L'hôte sait limiter un bail à une session Hermes (portée `thread`). Sans elle, un bail `thread` est refusé, jamais élargi. */
export const RELAY_FEATURE_YOLO_THREAD_SCOPE = "yolo_thread_scope";

export const YOLO_SCOPES = ["thread", "bot", "runtime"] as const;
export type YoloScope = (typeof YOLO_SCOPES)[number];

/** Version de la charge utile canonique du bail. */
export const YOLO_LEASE_VERSION = 1 as const;
/**
 * Préfixe de domaine du message signé : `prefix || canonical(lease)`. Calqué
 * sur le préfixe de la preuve de possession ; identifiant technique, figé.
 */
export const YOLO_LEASE_SIGNING_PREFIX = "ohb-yolo-lease/v1\n";

/** Bornes de la deny-list d'organisation portée par un bail. */
export const YOLO_DENY_MAX_ENTRIES = 50;
export const YOLO_DENY_MAX_LENGTH = 256;
/** Bornes de `protect` : des identifiants de protection, jamais vide. */
export const YOLO_PROTECT_MAX_ENTRIES = 32;
/** `yolo.state` décrit au plus autant de baux. */
export const YOLO_STATE_MAX_LEASES = 64;
/** `yolo.audit` porte au plus autant d'entrées (la trame reste sous 64 KiB). */
export const YOLO_AUDIT_MAX_ENTRIES = 128;

export const YOLO_HOST_LEASE_STATUSES = ["active", "expired", "revoked", "rejected"] as const;
export type YoloHostLeaseStatus = (typeof YOLO_HOST_LEASE_STATUSES)[number];

export type YoloLeaseDenyList = { commands: string[]; tools: string[]; paths: string[] };

/**
 * La charge utile canonique d'un bail, v1. Entiers seulement (sous-ensemble
 * canonique de l'audit) ; les instants sont des secondes epoch.
 */
export type YoloLeaseV1 = {
  v: typeof YOLO_LEASE_VERSION;
  leaseId: string;
  organizationId: string;
  runtimeId: string;
  scope: YoloScope;
  /** Slug Hermes du bot (`bot`, `thread`) ; `null` pour `runtime`. */
  profile: string | null;
  /** `hex(sha256(session_id Hermes))` pour `thread`, sinon `null`. */
  sessionKey: string | null;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  /** L'utilisateur qui l'a octroyé : un identifiant, jamais un e-mail. */
  grantedBy: string;
  /** Deny-list d'organisation, optionnelle (listes vides). */
  deny: YoloLeaseDenyList;
  /** Protections actives (identifiants du catalogue partagé), jamais vide. */
  protect: string[];
};

/** openedbot → hôte : un bail signé Ed25519. `keyId` : 16 premiers octets hex de sha256(clé publique). */
export type RelayYoloLeaseFrame = { t: "yolo.lease"; lease: YoloLeaseV1; keyId: string; signature: string };
/** openedbot → hôte : une révocation ne peut que restreindre, elle n'est pas signée. Exactement un de `leaseId` ou `all`. */
export type RelayYoloRevokeFrame =
  | { t: "yolo.revoke"; leaseId: string; revokedAt: number }
  | { t: "yolo.revoke"; all: true; revokedAt: number };
export type RelayYoloLeaseState = { leaseId: string; status: YoloHostLeaseStatus; reason?: string };
/** Hôte → openedbot, après la preuve de possession et à chaque changement. `killedAt` : `edge-setup yolo off`. */
export type RelayYoloStateFrame = { t: "yolo.state"; leases: RelayYoloLeaseState[]; killedAt?: number };
/**
 * Une auto-approbation journalisée par l'hôte : le hash des arguments
 * seulement, jamais les arguments. `prevHash` / `entryHash` chaînent les
 * entrées ; la chaîne fait foi, pas la trame.
 */
export type RelayYoloAuditEntry = {
  seq: number;
  eventId: string;
  occurredAt: number;
  leaseId: string;
  profile: string;
  gateKind: string;
  toolKey: string | null;
  argsHash: string;
  prevHash: string;
  entryHash: string;
};
/** Hôte → openedbot : une tranche contiguë de l'audit local, `fromSeq..toSeq`, `tail` = dernier `entryHash`. */
export type RelayYoloAuditFrame = {
  t: "yolo.audit";
  runtimeId: string;
  entries: RelayYoloAuditEntry[];
  fromSeq: number;
  toSeq: number;
  tail: string;
};
/** openedbot → hôte : tout jusqu'à `toSeq` est conservé, l'hôte peut purger. */
export type RelayYoloAuditAckFrame = { t: "yolo.audit.ack"; toSeq: number };

export type RelayYoloFrame =
  | RelayYoloLeaseFrame
  | RelayYoloRevokeFrame
  | RelayYoloStateFrame
  | RelayYoloAuditFrame
  | RelayYoloAuditAckFrame;

const YOLO_FRAME_TYPES: ReadonlySet<string> = new Set(["yolo.lease", "yolo.revoke", "yolo.state", "yolo.audit", "yolo.audit.ack"]);
const LEASE_KEYS: ReadonlySet<string> = new Set([
  "v", "leaseId", "organizationId", "runtimeId", "scope", "profile", "sessionKey",
  "issuedAt", "notBefore", "expiresAt", "grantedBy", "deny", "protect",
]);
const DENY_KEYS: ReadonlySet<string> = new Set(["commands", "tools", "paths"]);
const KEY_ID_PATTERN = /^[0-9a-f]{32}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
/** Même forme que les slugs de profil côté hôte (`profileSlugRe`). */
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PROTECT_ID_PATTERN = /^[a-z0-9_]{1,32}$/;
const CODE_PATTERN = /^[a-z0-9_]{1,64}$/;
const GATE_KIND_PATTERN = /^[a-z_]{1,32}$/;
const MAX_RUNTIME_ID = 128;
const MAX_TOOL_KEY = 256;

/** `link.context` annonce au plus autant de clés de bail. */
export const YOLO_MAX_LEASE_KEYS = 8;
/**
 * Préfixe de domaine d'un endossement : `prefix || keyId || "\n" || publicKey`,
 * signé Ed25519 par la clé `endorsedBy`, déjà épinglée par l'hôte.
 */
export const YOLO_KEY_ENDORSEMENT_PREFIX = "ohb-yolo-key/v1\n";

/** Une clé publique de bail (32 octets bruts en base64) ; `keyId` = 16 premiers octets hex de sha256(clé). */
export type YoloLeaseKey = { keyId: string; publicKey: string; endorsedBy?: string; endorsement?: string };

const BASE64_32_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/** `link.context.leaseKeys` : absent ou `null` = aucune annonce. Champs inconnus ignorés, comme en Go. */
export function parseYoloLeaseKeys(value: unknown): YoloLeaseKey[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RelayFrameError("field leaseKeys must be an array");
  if (value.length > YOLO_MAX_LEASE_KEYS) throw new RelayFrameError(`field leaseKeys lists ${value.length} keys, more than ${YOLO_MAX_LEASE_KEYS}`);
  return value.map((entry) => {
    const key = object(entry, "lease key");
    const keyId = text(key, "keyId") ?? "";
    const publicKey = text(key, "publicKey") ?? "";
    if (!KEY_ID_PATTERN.test(keyId) || !BASE64_32_PATTERN.test(publicKey)) {
      throw new RelayFrameError("link.context lease key requires a 32-hex keyId and a 32-byte base64 publicKey");
    }
    const endorsedBy = text(key, "endorsedBy");
    const endorsement = text(key, "endorsement");
    if ((endorsedBy === undefined || endorsedBy === "") !== (endorsement === undefined || endorsement === "")) {
      throw new RelayFrameError("link.context lease key endorsement requires endorsedBy and a 64-byte base64 endorsement together");
    }
    if (!endorsedBy) return { keyId, publicKey };
    if (!KEY_ID_PATTERN.test(endorsedBy) || !BASE64_64_PATTERN.test(endorsement!)) {
      throw new RelayFrameError("link.context lease key endorsement requires endorsedBy and a 64-byte base64 endorsement together");
    }
    return { keyId, publicKey, endorsedBy, endorsement: endorsement! };
  });
}

export function isYoloFrameType(t: string): t is RelayYoloFrame["t"] {
  return YOLO_FRAME_TYPES.has(t);
}

/** Valide une trame `yolo.*` déjà analysée ; mêmes conventions que `decodeTextFrame`. */
export function decodeYoloFrame(t: RelayYoloFrame["t"], frame: Record<string, unknown>): RelayYoloFrame {
  switch (t) {
    case "yolo.lease": {
      const keyId = text(frame, "keyId") ?? "";
      const signature = text(frame, "signature") ?? "";
      if (!KEY_ID_PATTERN.test(keyId) || !BASE64_64_PATTERN.test(signature)) {
        throw new RelayFrameError("yolo.lease requires a 32-hex keyId and a 64-byte base64 signature");
      }
      return { t, lease: parseYoloLease(frame.lease), keyId, signature };
    }
    case "yolo.revoke": {
      const revokedAt = epoch(frame, "revokedAt");
      const leaseId = text(frame, "leaseId");
      const all = frame.all;
      if (all !== undefined && all !== null && all !== true) throw new RelayFrameError("yolo.revoke all must be true when present");
      if ((leaseId === undefined) === (all !== true)) throw new RelayFrameError("yolo.revoke requires exactly one of leaseId or all");
      if (leaseId !== undefined) {
        if (!isUuid(leaseId)) throw new RelayFrameError("yolo.revoke leaseId must be a UUID");
        return { t, leaseId, revokedAt };
      }
      return { t, all: true, revokedAt };
    }
    case "yolo.state": {
      const leases = list(frame, "leases", YOLO_STATE_MAX_LEASES).map(leaseState);
      const killedAt = frame.killedAt === undefined || frame.killedAt === null ? undefined : epoch(frame, "killedAt");
      return killedAt === undefined ? { t, leases } : { t, leases, killedAt };
    }
    case "yolo.audit":
      return auditFrame(frame);
    case "yolo.audit.ack": {
      const toSeq = epoch(frame, "toSeq");
      if (toSeq < 1) throw new RelayFrameError("yolo.audit.ack toSeq must be at least 1");
      return { t, toSeq };
    }
  }
}

/**
 * La forme d'une charge utile de bail v1, stricte : un champ inconnu est un
 * refus (le contenu signé est exactement celui de la v1, rien de plus).
 */
export function parseYoloLease(value: unknown): YoloLeaseV1 {
  const lease = object(value, "lease");
  for (const key of Object.keys(lease)) {
    if (!LEASE_KEYS.has(key)) throw new RelayFrameError(`lease has an unknown field ${key}`);
  }
  if (lease.v !== YOLO_LEASE_VERSION) throw new RelayFrameError("lease v must be 1");
  const runtimeId = text(lease, "runtimeId") ?? "";
  if (!runtimeId || runtimeId.length > MAX_RUNTIME_ID) throw new RelayFrameError("lease runtimeId is required");
  const scope = text(lease, "scope");
  if (!scope || !(YOLO_SCOPES as readonly string[]).includes(scope)) throw new RelayFrameError("lease scope must be thread|bot|runtime");
  const profile = nullableText(lease, "profile");
  if (profile !== null && !PROFILE_PATTERN.test(profile)) throw new RelayFrameError("lease profile must be a profile slug or null");
  const sessionKey = nullableText(lease, "sessionKey");
  if (sessionKey !== null && !HEX64_PATTERN.test(sessionKey)) throw new RelayFrameError("lease sessionKey must be 64 hex or null");
  const deny = object(lease.deny, "lease.deny");
  for (const key of Object.keys(deny)) {
    if (!DENY_KEYS.has(key)) throw new RelayFrameError(`lease.deny has an unknown field ${key}`);
  }
  const protect = textList(lease, "protect", YOLO_PROTECT_MAX_ENTRIES, 32);
  if (protect.length === 0 || protect.some((id) => !PROTECT_ID_PATTERN.test(id)) || new Set(protect).size !== protect.length) {
    throw new RelayFrameError("lease protect must list distinct protection ids, at least one");
  }
  return {
    v: YOLO_LEASE_VERSION,
    leaseId: uuid(lease, "leaseId"),
    organizationId: uuid(lease, "organizationId"),
    runtimeId,
    scope: scope as YoloScope,
    profile,
    sessionKey,
    issuedAt: epoch(lease, "issuedAt"),
    notBefore: epoch(lease, "notBefore"),
    expiresAt: epoch(lease, "expiresAt"),
    grantedBy: uuid(lease, "grantedBy"),
    deny: {
      commands: textList(deny, "commands", YOLO_DENY_MAX_ENTRIES, YOLO_DENY_MAX_LENGTH),
      tools: textList(deny, "tools", YOLO_DENY_MAX_ENTRIES, YOLO_DENY_MAX_LENGTH),
      paths: textList(deny, "paths", YOLO_DENY_MAX_ENTRIES, YOLO_DENY_MAX_LENGTH),
    },
    protect,
  };
}

function leaseState(entry: unknown): RelayYoloLeaseState {
  const state = object(entry, "yolo.state lease");
  const status = text(state, "status");
  if (!status || !(YOLO_HOST_LEASE_STATUSES as readonly string[]).includes(status)) {
    throw new RelayFrameError("yolo.state lease status must be active|expired|revoked|rejected");
  }
  const reason = text(state, "reason");
  if (reason !== undefined && !CODE_PATTERN.test(reason)) throw new RelayFrameError("yolo.state lease reason must be a code");
  const out: RelayYoloLeaseState = { leaseId: uuid(state, "leaseId"), status: status as YoloHostLeaseStatus };
  return reason === undefined ? out : { ...out, reason };
}

function auditFrame(frame: Record<string, unknown>): RelayYoloAuditFrame {
  const runtimeId = text(frame, "runtimeId") ?? "";
  if (!runtimeId || runtimeId.length > MAX_RUNTIME_ID) throw new RelayFrameError("yolo.audit requires runtimeId");
  const entries = list(frame, "entries", YOLO_AUDIT_MAX_ENTRIES).map(auditEntry);
  const fromSeq = epoch(frame, "fromSeq");
  const toSeq = epoch(frame, "toSeq");
  const tail = text(frame, "tail") ?? "";
  const first = entries[0];
  const last = entries.at(-1);
  if (!first || !last || first.seq !== fromSeq || last.seq !== toSeq || tail !== last.entryHash) {
    throw new RelayFrameError("yolo.audit requires entries spanning fromSeq..toSeq and ending on tail");
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const entry = entries[index]!;
    if (entry.seq !== previous.seq + 1 || entry.prevHash !== previous.entryHash) {
      throw new RelayFrameError("yolo.audit entries must be contiguous and chained");
    }
  }
  return { t: "yolo.audit", runtimeId, entries, fromSeq, toSeq, tail };
}

function auditEntry(value: unknown): RelayYoloAuditEntry {
  const entry = object(value, "yolo.audit entry");
  const seq = epoch(entry, "seq");
  const profile = text(entry, "profile") ?? "";
  const gateKind = text(entry, "gateKind") ?? "";
  const toolKey = nullableText(entry, "toolKey");
  const hashes = (["argsHash", "prevHash", "entryHash"] as const).map((key) => text(entry, key) ?? "");
  if (seq < 1 || !PROFILE_PATTERN.test(profile) || !GATE_KIND_PATTERN.test(gateKind)
    || (toolKey !== null && (!toolKey || toolKey.length > MAX_TOOL_KEY))
    || hashes.some((hash) => !HEX64_PATTERN.test(hash))) {
    throw new RelayFrameError("invalid yolo.audit entry");
  }
  const [argsHash, prevHash, entryHash] = hashes as [string, string, string];
  return {
    seq, eventId: uuid(entry, "eventId"), occurredAt: epoch(entry, "occurredAt"), leaseId: uuid(entry, "leaseId"),
    profile, gateKind, toolKey, argsHash, prevHash, entryHash,
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayFrameError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Absent ou `null` : non renseigné, comme dans `relay-frames.ts`. */
function text(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RelayFrameError(`field ${key} must be a string`);
  return value;
}

/** Un champ signé nullable : présent, chaîne ou `null` (jamais absent, la forme canonique en dépend). */
function nullableText(source: Record<string, unknown>, key: string): string | null {
  if (!(key in source)) throw new RelayFrameError(`field ${key} is required (null when unset)`);
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== "string" || !value) throw new RelayFrameError(`field ${key} must be a non-empty string or null`);
  return value;
}

function uuid(source: Record<string, unknown>, key: string): string {
  const value = text(source, key) ?? "";
  if (!isUuid(value)) throw new RelayFrameError(`field ${key} must be a UUID`);
  return value;
}

/** Un entier sûr et positif ou nul (secondes epoch, numéros de séquence). */
function epoch(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RelayFrameError(`field ${key} must be a non-negative integer`);
  }
  return value;
}

function list(source: Record<string, unknown>, key: string, max: number): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new RelayFrameError(`field ${key} must be an array`);
  if (value.length > max) throw new RelayFrameError(`field ${key} lists ${value.length} entries, more than ${max}`);
  return value;
}

function textList(source: Record<string, unknown>, key: string, max: number, maxLength: number): string[] {
  return list(source, key, max).map((entry) => {
    if (typeof entry !== "string" || !entry || entry.length > maxLength) {
      throw new RelayFrameError(`field ${key} must hold non-empty strings of at most ${maxLength} characters`);
    }
    return entry;
  });
}
