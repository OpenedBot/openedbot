import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendLocalChain,
  backfillLocalChain,
  chainLinkHash,
  payloadDigest,
  readLocalChain,
  verifyChainLinks,
  verifyLocalChain,
} from "../src/application/audit-chain";
import {
  AuditAnchorError,
  createAuditAnchoring,
  wormAuditAnchor,
  type AuditAnchor,
  type AuditAnchorEvent,
} from "../src/application/audit-anchor";
import { anchorObjectKey, anchorRecordBytes, MemoryAuditWormStore, type AuditWormStore } from "../src/application/audit-worm";
import { createLinkLivenessStore, type LinkIdentity } from "../src/application/broker";
import { chainDb } from "./fixtures/chain-db";

/**
 * Étape 5 : la chaîne de hachage locale (solo), son backfill idempotent, et
 * l'AuditAnchor — chaîne locale toujours, ancrage externe ensuite, bloquant
 * seulement pour une organisation qui tient `audit.anchor`.
 */
const ORG = "0b9c6a1e-0000-4000-8000-000000000001";
const RT = "8f3b2c1d-1111-4222-8333-444455556666";

function event(n: number, overrides: Partial<AuditAnchorEvent> = {}): AuditAnchorEvent {
  const payload = { runtimeId: RT, keyId: "k-1", writeSeq: n, count: n, dropped: 0, tail: "a".repeat(64), receivedAt: "2026-10-28T09:00:00.000Z" };
  return { organizationId: ORG, runtimeId: RT, kind: "runtime_anchor", objectKey: anchorObjectKey(RT, n), payload, bytes: anchorRecordBytes(payload), ...overrides };
}

describe("chaîne locale : ajout puis vérification", () => {
  test("trois maillons chaînés depuis seq 1, vérifiés, tête = dernier hash", async () => {
    const { tx, rows } = chainDb();
    const first = await appendLocalChain(tx, event(1));
    const second = await appendLocalChain(tx, event(2));
    const third = await appendLocalChain(tx, { ...event(3), kind: "audit_verdict", objectKey: `audit/${RT}/verdicts/v-1.json` });
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.prevHash)).toEqual([null, first.hash, second.hash]);
    expect(rows[1]!.hash).toBe(chainLinkHash({ seq: 2, prevHash: first.hash, kind: "runtime_anchor", payloadSha256: payloadDigest(event(2).payload) }));
    expect(await verifyLocalChain(tx, ORG, RT)).toEqual({ valid: true, length: 3, head: third.hash });
    // Une autre organisation ne lit rien de cette chaîne.
    expect(await verifyLocalChain(tx, "other-org", RT)).toEqual({ valid: true, length: 0, head: null });
  });

  test("le même objet n'est jamais chaîné deux fois (append-only, rejouable)", async () => {
    const { tx, rows } = chainDb();
    const first = await appendLocalChain(tx, event(1));
    const again = await appendLocalChain(tx, event(1));
    expect(again).toEqual({ seq: 1, hash: first.hash, appended: false });
    expect(rows).toHaveLength(1);
  });

  test("toute altération est détectée : payload, hash, lien précédent, trou", async () => {
    const { tx } = chainDb();
    for (const n of [1, 2, 3]) await appendLocalChain(tx, event(n));
    const links = await readLocalChain(tx, ORG, RT);
    expect(verifyChainLinks(links).valid).toBe(true);
    const payloadEdited = links.map((link, index) => index === 1 ? { ...link, payload: { ...link.payload, tail: "b".repeat(64) } } : link);
    expect(verifyChainLinks(payloadEdited)).toMatchObject({ valid: false, brokenAt: 2, reason: "payload_mismatch" });
    const rehashed = links.map((link, index) => index === 1 ? { ...link, payloadSha256: payloadDigest({ x: 1 }), payload: { x: 1 } } : link);
    expect(verifyChainLinks(rehashed)).toMatchObject({ valid: false, brokenAt: 2, reason: "hash_mismatch" });
    expect(verifyChainLinks([links[0]!, links[2]!])).toMatchObject({ valid: false, brokenAt: 3, reason: "seq_gap" });
    const relinked = links.map((link, index) => index === 2 ? { ...link, prevHash: "0".repeat(64) } : link);
    expect(verifyChainLinks(relinked)).toMatchObject({ valid: false, brokenAt: 3, reason: "prev_mismatch" });
  });

  test("la migration 0152 : append-only (trigger, aucune grant update/delete), RLS forcée, enregistrée", () => {
    const sql = readFileSync(join(import.meta.dir, "../../../db/migrations/0152_audit_local_chain.sql"), "utf8");
    expect(sql).toContain("create trigger audit_chain_no_update");
    expect(sql).toContain("force row level security");
    expect(sql).not.toMatch(/grant[^;]*(update|delete)[^;]*audit_chain/i);
    expect(sql).toContain("insert into schema_migrations(version) values ('0152_audit_local_chain')");
  });
});

describe("backfill de la chaîne locale", () => {
  const verifications = [
    { id: "v-1", runtimeId: RT, keyId: "k-1", exportSha256: "e".repeat(64), verdict: "valid", errorCode: null, anchor: "matches", worm: "matches", writeSeq: "3", count: 2, dropped: "0", tail: "a".repeat(64), signature: "sig-1", signatureKeyId: "vk", receivedAt: new Date("2026-10-01T10:00:00Z") },
    { id: "v-2", runtimeId: RT, keyId: "k-1", exportSha256: "f".repeat(64), verdict: "invalid", errorCode: "AUDIT_CHAIN_BROKEN", anchor: "none", worm: "disabled", writeSeq: null, count: null, dropped: null, tail: null, signature: "sig-2", signatureKeyId: "vk", receivedAt: new Date("2026-10-02T10:00:00Z") },
  ];
  const anchors = [{ keyId: "k-1", writeSeq: "4", count: 3, dropped: "0", tail: "c".repeat(64), receivedAt: new Date("2026-10-03T10:00:00Z") }];

  test("lancé deux fois : la première chaîne verdicts puis ancre, la seconde n'ajoute ni ne change rien", async () => {
    const { tx, rows } = chainDb({ verifications, anchors });
    expect(await backfillLocalChain(tx, ORG, RT)).toBe(3);
    const snapshot = JSON.stringify(rows);
    expect(rows.map((row) => [row.seq, row.kind, row.objectKey])).toEqual([
      [1, "audit_verdict", `audit/${RT}/verdicts/v-1.json`],
      [2, "audit_verdict", `audit/${RT}/verdicts/v-2.json`],
      [3, "runtime_anchor", anchorObjectKey(RT, 4)],
    ]);
    expect(rows[0]!.payload).toMatchObject({ backfill: true, receivedAt: "2026-10-01T10:00:00.000Z" });
    expect(await backfillLocalChain(tx, ORG, RT)).toBe(0);
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect((await verifyLocalChain(tx, ORG, RT)).valid).toBe(true);
  });

  test("après des maillons vivants, le backfill ne reprend que ce qui manque", async () => {
    const { tx, rows } = chainDb({ verifications, anchors });
    await appendLocalChain(tx, { ...event(4), payload: { live: true } });
    expect(await backfillLocalChain(tx, ORG, RT)).toBe(2);
    expect(await backfillLocalChain(tx, ORG, RT)).toBe(0);
    expect(rows).toHaveLength(3);
    expect((await verifyLocalChain(tx, ORG, RT)).valid).toBe(true);
  });
});

describe("AuditAnchor : chaîne locale puis ancrage externe", () => {
  const failing: AuditAnchor = { id: "test", anchor: async () => { throw new Error("anchor unreachable"); } };

  test("sans ancrage externe (solo) : la chaîne locale seule", async () => {
    const { tx, rows } = chainDb();
    const outcome = await createAuditAnchoring()(tx, event(1));
    expect(outcome.external).toEqual({ state: "none" });
    expect(rows).toHaveLength(1);
  });

  test("installation legacy : le bucket WORM reçoit les octets une fois ; un objet déjà là n'est pas un échec", async () => {
    const { tx } = chainDb();
    const worm = new MemoryAuditWormStore();
    const anchoring = createAuditAnchoring({ anchor: wormAuditAnchor(worm) });
    expect((await anchoring(tx, event(1))).external).toEqual({ state: "anchored", anchorId: "worm:memory" });
    expect(new TextDecoder().decode((await worm.get(anchorObjectKey(RT, 1)))!)).toBe(new TextDecoder().decode(event(1).bytes));
    const { tx: other } = chainDb();
    expect((await createAuditAnchoring({ anchor: wormAuditAnchor(worm) })(other, event(1))).external.state).toBe("anchored");
  });

  test("échec NON bloquant (pas d'audit.anchor) : rendu à l'appelant, le maillon local reste", async () => {
    const { tx, rows } = chainDb();
    const outcome = await createAuditAnchoring({ anchor: failing, blocking: async () => false })(tx, event(1));
    expect(outcome.external).toEqual({ state: "failed", anchorId: "test", error: "anchor unreachable" });
    expect(rows).toHaveLength(1);
  });

  test("échec BLOQUANT (audit.anchor) : AuditAnchorError 503 AUDIT_ANCHOR_FAILED, message clair", async () => {
    const { db } = chainDb();
    const asked: string[] = [];
    const anchoring = createAuditAnchoring({ anchor: failing, blocking: async (organizationId) => { asked.push(organizationId); return true; } });
    const error = await db.begin((tx) => anchoring(tx, event(1))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuditAnchorError);
    expect(error).toMatchObject({ status: 503, code: "AUDIT_ANCHOR_FAILED", anchorId: "test", reason: "anchor unreachable" });
    expect((error as Error).message).toContain("L’ancrage externe de l’audit a échoué");
    expect(asked).toEqual([ORG]);
  });

  test("un ancrage qui ne répond pas expire ; une vérification d'entitlement en échec ne bloque pas", async () => {
    const { tx } = chainDb();
    const hanging: AuditAnchor = { id: "slow", anchor: () => new Promise(() => undefined) };
    const outcome = await createAuditAnchoring({ anchor: hanging, timeoutMs: 10, blocking: async () => { throw new Error("db down"); } })(tx, event(1));
    expect(outcome.external).toMatchObject({ state: "failed", error: "no answer within 10 ms" });
  });

  test("un maillon dont l'ancrage externe a échoué est ré-ancré au rejeu, avec ses octets d'origine", async () => {
    const { tx, rows } = chainDb();
    const worm = new MemoryAuditWormStore();
    let down = true;
    const flaky: AuditAnchor = { id: "flaky", anchor: async (txn, anchored) => {
      if (down) throw new Error("bucket unreachable");
      await wormAuditAnchor(worm).anchor(txn, anchored);
    } };
    const anchoring = createAuditAnchoring({ anchor: flaky, blocking: async () => false });
    expect((await anchoring(tx, event(1))).external).toMatchObject({ state: "failed" });
    down = false;
    // Le rejeu porte une autre heure de réception : seul le contenu chaîné part.
    const replay = event(1);
    const later = { ...replay.payload, receivedAt: "2026-10-28T10:00:00.000Z" };
    const outcome = await anchoring(tx, { ...replay, payload: later, bytes: anchorRecordBytes(later as never) });
    expect(outcome.local.appended).toBe(false);
    expect(outcome.external).toEqual({ state: "anchored", anchorId: "flaky" });
    expect(rows).toHaveLength(1);
    expect(new TextDecoder().decode((await worm.get(anchorObjectKey(RT, 1)))!)).toBe(new TextDecoder().decode(event(1).bytes));
    // Déjà déposé : un nouveau rejeu reste idempotent.
    expect((await anchoring(tx, event(1))).external).toEqual({ state: "anchored", anchorId: "flaky" });
    expect(worm.keys()).toEqual([anchorObjectKey(RT, 1)]);
  });

  test("un maillon chaîné qui ne correspond plus à son empreinte n'est jamais ancré", async () => {
    const { tx, rows } = chainDb();
    const sent: string[] = [];
    const recording: AuditAnchor = { id: "rec", anchor: async (_txn, anchored) => { sent.push(anchored.objectKey); } };
    const anchoring = createAuditAnchoring({ anchor: recording, blocking: async () => false });
    await anchoring(tx, event(1));
    rows[0]!.payload = { ...rows[0]!.payload, tail: "b".repeat(64) };
    expect((await anchoring(tx, event(1))).external).toMatchObject({ state: "failed", error: expect.stringContaining("does not match its digest") });
    expect(sent).toHaveLength(1);
  });
});

describe("vitalité du lien : l'ancre est chaînée et ancrée dans sa transaction", () => {
  const link: LinkIdentity = { runtimeId: RT, organizationId: ORG, tokenHash: "hash", expiresAt: null };
  const frame = { t: "audit.anchor" as const, runtimeId: RT, keyId: "k-1", writeSeq: 3, count: 2, dropped: 0, tail: "a".repeat(64) };
  const other = (sql: string) => {
    if (sql.includes("from runtime_audit_keys")) return [{ keyId: "k-1" }];
    if (sql.includes("insert into runtime_audit_anchors")) return [{ runtimeId: RT }];
    return undefined;
  };
  const failing: AuditWormStore = { mode: "memory", putOnce: async () => { throw new Error("bucket unreachable"); }, get: async () => null };

  test("enregistrée : un maillon runtime_anchor sous la clé WORM, l'objet déposé avant le commit", async () => {
    const { db, rows } = chainDb({ other });
    const worm = new MemoryAuditWormStore();
    const store = createLinkLivenessStore(db, { worm, now: () => new Date("2026-10-28T09:00:00Z") });
    expect(await store.auditAnchor!(link, frame)).toBe("recorded");
    expect(rows.map((row) => [row.kind, row.objectKey])).toEqual([["runtime_anchor", anchorObjectKey(RT, 3)]]);
    expect(worm.keys()).toEqual([anchorObjectKey(RT, 3)]);
  });

  test("non bloquant : l'ancre et son maillon restent, worm_write_failed est journalisé", async () => {
    const { db, rows, statements } = chainDb({ other });
    const store = createLinkLivenessStore(db, { worm: failing, anchorBlocking: async () => false });
    expect(await store.auditAnchor!(link, frame)).toBe("recorded");
    expect(rows).toHaveLength(1);
    const journal = statements.find((entry) => entry.sql.includes("insert into runtime_link_events"));
    expect(journal?.values[2]).toBe("worm_write_failed");
    expect(journal?.values[6]).toMatchObject({ reason: "anchor", keyId: "k-1", writeSeq: 3 });
  });

  test("bloquant : AuditAnchorError, la transaction est annulée (aucun maillon), rien n'est journalisé", async () => {
    const { db, rows, statements } = chainDb({ other });
    const store = createLinkLivenessStore(db, { worm: failing, anchorBlocking: async () => true });
    await expect(store.auditAnchor!(link, frame)).rejects.toBeInstanceOf(AuditAnchorError);
    expect(rows).toHaveLength(0);
    expect(statements.some((entry) => entry.sql.includes("insert into runtime_link_events"))).toBe(false);
  });
});
