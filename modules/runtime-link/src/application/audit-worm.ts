import { isStrictUuid } from "@openedbot/contracts-primitives";
import { canonicalJson } from "@openedbot/hermes";
import type { AuditChainKind } from "./audit-chain";

/**
 * The external archive of the creation audit: the `auditArchive` port of the
 * plug-in `audit` (`AuditArchivePort` of `@openedbot/platform-plugins`, same
 * shape; `apps/api` checks they stay equal).
 *
 * The openedbot database keeps the last anchor of each runtime, the verdicts
 * and the local hash chain (`audit_chain`), which is the core's own
 * anchoring. When a plug-in installs an archive, each anchor and each
 * verdict is ALSO deposited there, once, outside the database (a write-once
 * store, for example). Without one (the core's default) everything stays in
 * PostgreSQL and every verification says `worm: disabled`.
 *
 * This file keeps what the core knows of an archive without depending on
 * one: the object names (the same key as the local chain's link), the bytes
 * of an anchor, how to read them back and how to compare them.
 */
export type AuditArchiveRecord = {
  organizationId: string;
  runtimeId: string;
  kind: AuditChainKind;
  objectKey: string;
  /** The canonical JSON of the payload: the very bytes the local chain digests. */
  bytes: Uint8Array;
};

/** A deposit attempted inside a business transaction that then rolled back. */
export type AuditArchiveAttempt = {
  organizationId: string;
  runtimeId: string;
  kind: AuditChainKind;
  objectKey: string;
  anchorId: string;
  /** `confirmed`: the archive answered. `unknown`: it failed or timed out, the object may exist. */
  written: "confirmed" | "unknown";
};

export type AuditArchive = {
  /** For logs and orphan marks; at most 128 characters. */
  readonly id: string;
  /**
   * Deposits `record.bytes` under `record.objectKey` if nothing is there
   * yet, inside the business transaction `tx`; never rewrites, idempotent
   * per key. Throws on failure.
   */
  put(tx: unknown, record: AuditArchiveRecord): Promise<void>;
  /** The archived bytes, or `null` when they were never deposited. */
  get(objectKey: string): Promise<Uint8Array | null>;
  /**
   * Called in a transaction of its own, under the same context (tenant or
   * link credential), when the business transaction that attempted these
   * deposits rolled back: the object may exist with no chain link pointing
   * to it. Must delete nothing. Absent: nothing is marked.
   */
  orphaned?(tx: unknown, attempts: readonly AuditArchiveAttempt[], reason: string): Promise<void>;
};

/** What an archived anchor carries: the frame's fields and the time the API received it. */
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

/** `audit/<runtimeId>/anchors/<writeSeq on 12 digits>.json`: lexical order is write order. */
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

/** The anchor as canonical JSON: the same bytes whichever process deposits it. */
export function anchorRecordBytes(record: WormAnchorRecord): Uint8Array {
  return canonicalJson(record);
}

/** Reads an archived anchor back; `null` when the bytes do not describe a well-formed anchor. */
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

/** Does an archived anchor describe the same position as `expected`? `receivedAt` is informative, never compared. */
export function sameAnchor(record: WormAnchorRecord, expected: Pick<WormAnchorRecord, "runtimeId" | "keyId" | "writeSeq" | "count" | "dropped" | "tail">): boolean {
  return record.runtimeId === expected.runtimeId && record.keyId === expected.keyId && record.writeSeq === expected.writeSeq
    && record.count === expected.count && record.dropped === expected.dropped && record.tail === expected.tail;
}

/**
 * The archive of the tests: write-once in memory, never shared between
 * processes. Its default id is the one the legacy WORM install used in
 * memory, so traces keep reading the same.
 */
export class MemoryAuditArchive implements AuditArchive {
  readonly id: string;
  private readonly objects = new Map<string, Uint8Array>();

  constructor(id = "worm:memory") {
    this.id = id;
  }

  async put(_tx: unknown, record: AuditArchiveRecord): Promise<void> {
    assertKey(record.objectKey);
    if (!this.objects.has(record.objectKey)) this.objects.set(record.objectKey, new Uint8Array(record.bytes));
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    const found = this.objects.get(key);
    return found ? new Uint8Array(found) : null;
  }

  /** Direct read for tests: the deposited keys, in order. */
  keys(): string[] {
    return [...this.objects.keys()];
  }

  /** Direct write for tests: an archive rewritten outside the core. */
  overwrite(key: string, bytes: Uint8Array): void {
    assertKey(key);
    this.objects.set(key, new Uint8Array(bytes));
  }
}

function assertKey(key: string): void {
  if (!isValidWormObjectKey(key)) throw new Error("Invalid WORM object key.");
}
