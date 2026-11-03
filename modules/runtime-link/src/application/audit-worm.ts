import { isStrictUuid } from "@openedbot/contracts-primitives";
import { canonicalJson } from "@openedbot/hermes";
import type { AuditWormConfig } from "@openedbot/platform-config/api-config";

/**
 * L'ancrage WORM (write once, read many) de l'audit de création (OHB-57).
 *
 * La base openedbot tient la dernière ancre de chaque runtime et les verdicts ;
 * une compromission de cette base peut les réécrire. Chaque ancre reçue et
 * chaque verdict rendu sont donc AUSSI déposés, une fois et une seule, dans
 * un bucket R2 dédié sous verrou de rétention (≥ 365 jours), avec deux paires
 * de credentials distinctes du blob store : la paire « write » (Object Read
 * & Write, restreinte à ce bucket) ne sert qu'aux dépôts, la paire « read »
 * (Object Read only) qu'à la vérification. Le verrou du bucket interdit la
 * réécriture et la suppression côté fournisseur ; le client vérifie en plus
 * l'absence de l'objet avant de le déposer, ce qui laisse une fenêtre entre
 * la lecture et l'écriture, c'est le verrou qui tient l'invariant, pas ce
 * contrôle.
 *
 * L'écriture est asynchrone et n'interrompt jamais le lien ni la
 * vérification : un dépôt qui échoue est journalisé (`worm_write_failed`)
 * et la vérification suivante dira `worm: missing`.
 */
export type WormPut = "written" | "exists";

export type AuditWormStore = {
  readonly mode: "memory" | "r2";
  /** Dépose `bytes` sous `key` si rien n'y est encore ; ne réécrit jamais. */
  putOnce(key: string, bytes: Uint8Array): Promise<WormPut>;
  /** L'objet, ou `null` s'il n'a jamais été déposé. */
  get(key: string): Promise<Uint8Array | null>;
};

/** Ce qu'une ancre archivée porte : les champs de la trame et l'heure de réception côté API. */
export type WormAnchorRecord = {
  runtimeId: string;
  keyId: string;
  writeSeq: number;
  count: number;
  dropped: number;
  tail: string;
  receivedAt: string;
};

const KEY_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const TAIL = /^[0-9a-f]{64}$/;
const OBJECT_KEY = /^audit\/[0-9a-f-]{36}\/(anchors\/\d{12}|verdicts\/[0-9a-f-]{36})\.json$/i;

/** `audit/<runtimeId>/anchors/<writeSeq sur 12 chiffres>.json` : l'ordre lexical est l'ordre des écritures. */
export function anchorObjectKey(runtimeId: string, writeSeq: number): string {
  if (!isStrictUuid(runtimeId)) throw new Error("Invalid runtime id for a WORM anchor key.");
  if (!Number.isSafeInteger(writeSeq) || writeSeq < 0 || writeSeq > 999_999_999_999) throw new Error("Invalid writeSeq for a WORM anchor key.");
  return `audit/${runtimeId}/anchors/${String(writeSeq).padStart(12, "0")}.json`;
}

export function verdictObjectKey(runtimeId: string, verdictId: string): string {
  if (!isStrictUuid(runtimeId) || !isStrictUuid(verdictId)) throw new Error("Invalid identity for a WORM verdict key.");
  return `audit/${runtimeId}/verdicts/${verdictId}.json`;
}

export function isValidWormObjectKey(key: string): boolean {
  return OBJECT_KEY.test(key) && !key.includes("..") && !key.includes("\\");
}

/** L'ancre en JSON canonique : les mêmes octets quel que soit le processus qui la dépose. */
export function anchorRecordBytes(record: WormAnchorRecord): Uint8Array {
  return canonicalJson(record);
}

/** Relit une ancre archivée ; `null` si les octets ne décrivent pas une ancre bien formée. */
export function parseWormAnchor(bytes: Uint8Array): WormAnchorRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const runtimeId = record.runtimeId;
  const keyId = record.keyId;
  const writeSeq = record.writeSeq;
  const count = record.count;
  const dropped = record.dropped;
  const tail = record.tail;
  const receivedAt = record.receivedAt;
  if (typeof runtimeId !== "string" || !isStrictUuid(runtimeId)) return null;
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return null;
  if (typeof writeSeq !== "number" || !Number.isSafeInteger(writeSeq) || writeSeq < 0) return null;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  if (typeof dropped !== "number" || !Number.isSafeInteger(dropped) || dropped < 0) return null;
  if (typeof tail !== "string" || !TAIL.test(tail)) return null;
  if (typeof receivedAt !== "string" || !Number.isFinite(Date.parse(receivedAt))) return null;
  return { runtimeId, keyId, writeSeq, count, dropped, tail, receivedAt };
}

/** Une ancre archivée décrit-elle la même position que `expected` ? `receivedAt` est informatif, jamais comparé. */
export function sameAnchor(record: WormAnchorRecord, expected: Pick<WormAnchorRecord, "runtimeId" | "keyId" | "writeSeq" | "count" | "dropped" | "tail">): boolean {
  return record.runtimeId === expected.runtimeId && record.keyId === expected.keyId && record.writeSeq === expected.writeSeq
    && record.count === expected.count && record.dropped === expected.dropped && record.tail === expected.tail;
}

/** Le store des tests et du développement hors R2 : write-once en mémoire, jamais partagé entre processus. */
export class MemoryAuditWormStore implements AuditWormStore {
  readonly mode = "memory" as const;
  private readonly objects = new Map<string, Uint8Array>();

  async putOnce(key: string, bytes: Uint8Array): Promise<WormPut> {
    assertKey(key);
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, new Uint8Array(bytes));
    return "written";
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    const found = this.objects.get(key);
    return found ? new Uint8Array(found) : null;
  }

  /** Lecture directe pour les tests : les clés déposées, dans l'ordre. */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}

/** Le bucket R2 verrouillé : la paire write dépose, la paire read relit. */
export class R2AuditWormStore implements AuditWormStore {
  readonly mode = "r2" as const;
  private readonly writer: Bun.S3Client;
  private readonly reader: Bun.S3Client;

  constructor(config: Extract<AuditWormConfig, { mode: "r2" }>) {
    const base = { bucket: config.bucket, endpoint: config.endpoint, region: "auto" };
    this.writer = new Bun.S3Client({ ...base, accessKeyId: config.write.accessKeyId, secretAccessKey: config.write.secretAccessKey });
    this.reader = new Bun.S3Client({ ...base, accessKeyId: config.read.accessKeyId, secretAccessKey: config.read.secretAccessKey });
  }

  async putOnce(key: string, bytes: Uint8Array): Promise<WormPut> {
    assertKey(key);
    // Le verrou du bucket refuse la réécriture ; ce contrôle évite seulement
    // de la tenter (et son erreur) quand l'objet est déjà là.
    if (await this.writer.exists(key)) return "exists";
    await this.writer.write(key, bytes, { type: "application/json", acl: "private" });
    return "written";
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    const file = this.reader.file(key);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  }
}

export function createAuditWormStore(config: AuditWormConfig): AuditWormStore | null {
  return config.mode === "disabled" ? null : new R2AuditWormStore(config);
}

function assertKey(key: string): void {
  if (!isValidWormObjectKey(key)) throw new Error("Invalid WORM object key.");
}

export type WormArchiveOutcome = WormPut | "failed";

/**
 * Dépose sans jamais lever : un échec est rendu, pour que l'appelant le
 * journalise, et n'interrompt ni le lien ni la réponse en cours.
 */
export async function archiveOnce(store: AuditWormStore, key: string, bytes: Uint8Array): Promise<{ outcome: WormArchiveOutcome; error?: string }> {
  try {
    return { outcome: await store.putOnce(key, bytes) };
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
