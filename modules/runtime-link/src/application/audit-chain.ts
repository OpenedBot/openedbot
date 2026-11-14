/**
 * The local hash chain of the creation audit (`audit_chain`, 0152): the
 * core's own anchoring, in solo mode as in pro.
 *
 * One chain per runtime. Each link commits to the previous one and to the
 * SHA-256 of its payload (the anchor record, or the signed verdict):
 *
 *   hash = sha256(canonicalJson({ v: 1, seq, prev, kind, payloadSha256 }))
 *
 * Identifiers are not hashed directly (the payload digest covers them), so
 * an archive whose identifiers were pseudonymized still verifies.
 *
 * Append-only: a link is written once and never rewritten. Appending the
 * same `objectKey` twice returns the existing link (idempotent), which is
 * what makes the backfill replayable.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@openedbot/hermes";
import type { TransactionDb } from "@openedbot/platform-db";

export const AUDIT_CHAIN_VERSION = 1 as const;

export type AuditChainKind = "runtime_anchor" | "audit_verdict";

export type AuditChainEntry = {
  organizationId: string;
  runtimeId: string;
  kind: AuditChainKind;
  /** The WORM object key of the same record: one link per key. */
  objectKey: string;
  payload: Record<string, unknown>;
};

export type AuditChainLink = {
  seq: number;
  kind: AuditChainKind;
  objectKey: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  prevHash: string | null;
  hash: string;
};

export type AppendedLink = { seq: number; hash: string; appended: boolean };

export type ChainVerification =
  | { valid: true; length: number; head: string | null }
  | { valid: false; length: number; head: string | null; brokenAt: number; reason: "seq_gap" | "prev_mismatch" | "payload_mismatch" | "hash_mismatch" };

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function payloadDigest(payload: Record<string, unknown>): string {
  return sha256(canonicalJson(payload));
}

export function chainLinkHash(link: { seq: number; prevHash: string | null; kind: AuditChainKind; payloadSha256: string }): string {
  return sha256(canonicalJson({ v: AUDIT_CHAIN_VERSION, seq: link.seq, prev: link.prevHash, kind: link.kind, payloadSha256: link.payloadSha256 }));
}

/**
 * Appends one link in the caller's transaction. Concurrent appends to the
 * same runtime serialize on a transaction-scoped advisory lock; the
 * primary key `(runtime_id, seq)` would refuse a fork anyway.
 */
export async function appendLocalChain(tx: TransactionDb, entry: AuditChainEntry): Promise<AppendedLink> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`audit_chain:${entry.runtimeId}`}, 0))`;
  const existing = await tx<Array<{ seq: string | number; hash: string }>>`
    select seq, hash from audit_chain where runtime_id = ${entry.runtimeId} and object_key = ${entry.objectKey}
  `;
  if (existing[0]) return { seq: Number(existing[0].seq), hash: existing[0].hash, appended: false };
  const last = await tx<Array<{ seq: string | number; hash: string }>>`
    select seq, hash from audit_chain where runtime_id = ${entry.runtimeId} order by seq desc limit 1
  `;
  const seq = last[0] ? Number(last[0].seq) + 1 : 1;
  const prevHash = last[0]?.hash ?? null;
  const payloadSha256 = payloadDigest(entry.payload);
  const hash = chainLinkHash({ seq, prevHash, kind: entry.kind, payloadSha256 });
  await tx`
    insert into audit_chain (organization_id, runtime_id, seq, kind, object_key, payload, payload_sha256, prev_hash, hash)
    values (${entry.organizationId}, ${entry.runtimeId}, ${seq}, ${entry.kind}, ${entry.objectKey}, ${entry.payload}::jsonb,
            ${payloadSha256}, ${prevHash}, ${hash})
  `;
  return { seq, hash, appended: true };
}

/** Pure: does this sequence of links form an unbroken chain from seq 1? */
export function verifyChainLinks(links: readonly AuditChainLink[]): ChainVerification {
  let prev: string | null = null;
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index]!;
    const head = index === 0 ? null : links[index - 1]!.hash;
    const broken = (reason: Extract<ChainVerification, { valid: false }>["reason"]): ChainVerification =>
      ({ valid: false, length: links.length, head, brokenAt: link.seq, reason });
    if (link.seq !== index + 1) return broken("seq_gap");
    if (link.prevHash !== prev) return broken("prev_mismatch");
    if (payloadDigest(link.payload) !== link.payloadSha256) return broken("payload_mismatch");
    if (chainLinkHash(link) !== link.hash) return broken("hash_mismatch");
    prev = link.hash;
  }
  return { valid: true, length: links.length, head: prev };
}

export async function readLocalChain(tx: TransactionDb, organizationId: string, runtimeId: string): Promise<AuditChainLink[]> {
  const rows = await tx<Array<Omit<AuditChainLink, "seq"> & { seq: string | number }>>`
    select seq, kind, object_key as "objectKey", payload, payload_sha256 as "payloadSha256", prev_hash as "prevHash", hash
      from audit_chain where organization_id = ${organizationId} and runtime_id = ${runtimeId}
     order by seq
  `;
  return rows.map((row) => ({ ...row, seq: Number(row.seq) }));
}

/** The only audit read the core exposes: is this runtime's local chain intact? */
export async function verifyLocalChain(tx: TransactionDb, organizationId: string, runtimeId: string): Promise<ChainVerification> {
  return verifyChainLinks(await readLocalChain(tx, organizationId, runtimeId));
}

/**
 * Chains what existed before 0152: every verdict of the runtime (oldest
 * first), then its current anchor, each under its WORM object key. Already
 * chained keys are skipped, so a second run appends nothing and changes
 * nothing: replayable, no side effect besides the missing links.
 */
export async function backfillLocalChain(tx: TransactionDb, organizationId: string, runtimeId: string): Promise<number> {
  const verdicts = await tx<Array<Record<string, unknown> & { id: string }>>`
    select id, runtime_id as "runtimeId", key_id as "keyId", export_sha256 as "exportSha256", verdict, error_code as "errorCode",
           anchor_state as "anchor", worm_state as "worm", write_seq::text as "writeSeq", event_count as "count", dropped::text as dropped,
           tail, signature, signature_key_id as "signatureKeyId", received_at as "receivedAt"
      from runtime_audit_verifications
     where organization_id = ${organizationId} and runtime_id = ${runtimeId}
     order by received_at, id
  `;
  const anchors = await tx<Array<{ keyId: string; writeSeq: string | number; count: number; dropped: string | number; tail: string; receivedAt: Date | string }>>`
    select key_id as "keyId", write_seq as "writeSeq", event_count as "count", dropped, tail, received_at as "receivedAt"
      from runtime_audit_anchors where organization_id = ${organizationId} and runtime_id = ${runtimeId}
  `;
  let appended = 0;
  for (const verdict of verdicts) {
    const payload = { backfill: true, ...normalize(verdict) };
    const link = await appendLocalChain(tx, { organizationId, runtimeId, kind: "audit_verdict", objectKey: `audit/${runtimeId}/verdicts/${verdict.id}.json`, payload });
    if (link.appended) appended += 1;
  }
  for (const anchor of anchors) {
    const writeSeq = Number(anchor.writeSeq);
    const payload = { backfill: true, runtimeId, keyId: anchor.keyId, writeSeq, count: anchor.count, dropped: Number(anchor.dropped), tail: anchor.tail, receivedAt: iso(anchor.receivedAt) };
    const link = await appendLocalChain(tx, { organizationId, runtimeId, kind: "runtime_anchor", objectKey: `audit/${runtimeId}/anchors/${String(writeSeq).padStart(12, "0")}.json`, payload });
    if (link.appended) appended += 1;
  }
  return appended;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** JSON-safe, deterministic: dates as ISO strings, `undefined` dropped. */
function normalize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
