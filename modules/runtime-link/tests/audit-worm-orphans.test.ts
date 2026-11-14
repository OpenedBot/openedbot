import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuditAnchorError,
  createAuditAnchoring,
  archiveOrphanMarker,
  withWormOrphanMarking,
  archiveAuditAnchor,
  type AnchorAttempt,
  type AuditAnchorEvent,
} from "../src/application/audit-anchor";
import { anchorObjectKey, anchorRecordBytes, MemoryAuditArchive, type AuditArchive, type AuditArchiveAttempt } from "../src/application/audit-worm";
import { createLinkLivenessStore, type LinkIdentity } from "../src/application/broker";
import { chainDb } from "./fixtures/chain-db";

/**
 * Ordre 0b : un objet archivé dans une transaction annulée est confié à
 * l'archive (`AuditArchive.orphaned`, le plug-in `audit` le marque), jamais
 * supprimé, et l'erreur métier remonte telle quelle. Le cœur n'écrit plus
 * `audit_worm_orphans` lui-même.
 */
const ORG = "0b9c6a1e-0000-4000-8000-000000000001";
const RT = "8f3b2c1d-1111-4222-8333-444455556666";

function event(n: number): AuditAnchorEvent {
  const payload = { runtimeId: RT, keyId: "k-1", writeSeq: n, count: n, dropped: 0, tail: "a".repeat(64), receivedAt: "2026-10-28T09:00:00.000Z" };
  return { organizationId: ORG, runtimeId: RT, kind: "runtime_anchor", objectKey: anchorObjectKey(RT, n), payload, bytes: anchorRecordBytes(payload) };
}

/** An archive whose deposits fail, and which records what it is told is orphaned, with the transaction it got. */
function failingArchive() {
  const orphans: Array<{ tx: unknown; attempts: readonly AuditArchiveAttempt[]; reason: string }> = [];
  const archive: AuditArchive = {
    id: "worm:memory",
    put: async () => { throw new Error("bucket unreachable"); },
    get: async () => null,
    orphaned: async (tx, attempts, reason) => { orphans.push({ tx, attempts, reason }); },
  };
  return { archive, orphans };
}
const failing = failingArchive().archive;

function marker() {
  const marks: Array<{ attempts: readonly AnchorAttempt[]; reason: string }> = [];
  return { marks, mark: async (attempts: readonly AnchorAttempt[], reason: string) => { marks.push({ attempts, reason }); } };
}

describe("withWormOrphanMarking", () => {
  test("écrit puis annulé : l'objet est marqué `confirmed`, il reste dans le bucket, l'erreur remonte telle quelle", async () => {
    const { db, rows } = chainDb();
    const worm = new MemoryAuditArchive();
    const anchoring = createAuditAnchoring({ anchor: archiveAuditAnchor(worm) });
    const { marks, mark } = marker();
    const boom = new Error("insert failed after the anchor");
    const run = withWormOrphanMarking(anchoring, (tracked) => db.begin(async (tx) => {
      await tracked(tx, event(1));
      throw boom;
    }), mark);
    await expect(run).rejects.toBe(boom);
    expect(rows).toHaveLength(0);
    expect(worm.keys()).toEqual([anchorObjectKey(RT, 1)]);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.attempts).toEqual([{ organizationId: ORG, runtimeId: RT, kind: "runtime_anchor", objectKey: anchorObjectKey(RT, 1), anchorId: "worm:memory", written: "confirmed" }]);
    expect(marks[0]!.reason).toBe("Error: insert failed after the anchor");
  });

  test("ancrage bloquant en échec : marqué `unknown` (l'écriture a pu aboutir), AuditAnchorError remonte", async () => {
    const { db } = chainDb();
    const anchoring = createAuditAnchoring({ anchor: archiveAuditAnchor(failing), blocking: async () => true });
    const { marks, mark } = marker();
    const run = withWormOrphanMarking(anchoring, (tracked) => db.begin((tx) => tracked(tx, event(2))), mark);
    await expect(run).rejects.toBeInstanceOf(AuditAnchorError);
    expect(marks[0]!.attempts.map((attempt) => [attempt.objectKey, attempt.written])).toEqual([[anchorObjectKey(RT, 2), "unknown"]]);
    expect(marks[0]!.reason).toStartWith("AUDIT_ANCHOR_FAILED: bucket unreachable");
  });

  test("transaction validée, ou annulée sans tentative externe (solo) : aucun marquage", async () => {
    const { db } = chainDb();
    const { marks, mark } = marker();
    const anchored = createAuditAnchoring({ anchor: archiveAuditAnchor(new MemoryAuditArchive()) });
    await withWormOrphanMarking(anchored, (tracked) => db.begin((tx) => tracked(tx, event(3))), mark);
    const solo = createAuditAnchoring();
    await expect(withWormOrphanMarking(solo, (tracked) => db.begin(async (tx) => {
      await tracked(tx, event(4));
      throw new Error("later failure");
    }), mark)).rejects.toThrow("later failure");
    expect(marks).toHaveLength(0);
  });

  test("un marquage en échec est journalisé, jamais levé : l'erreur métier n'est pas masquée", async () => {
    const { db } = chainDb();
    const anchoring = createAuditAnchoring({ anchor: archiveAuditAnchor(new MemoryAuditArchive()) });
    const boom = new Error("commit failed");
    const run = withWormOrphanMarking(anchoring, (tracked) => db.begin(async (tx) => {
      await tracked(tx, event(5));
      throw boom;
    }), async () => { throw new Error("database down"); });
    await expect(run).rejects.toBe(boom);
  });

  test("archiveOrphanMarker : le hook de l'archive, dans la transaction ouverte par l'appelant ; sans hook ni archive, rien", async () => {
    const attempts: AnchorAttempt[] = [
      { organizationId: ORG, runtimeId: RT, kind: "audit_verdict", objectKey: `audit/${RT}/verdicts/v-1.json`, anchorId: "worm:s3", written: "unknown" },
    ];
    const { archive, orphans } = failingArchive();
    const opened: unknown[] = [];
    const open = async (work: (tx: never) => Promise<void>) => { const tx = { tenant: ORG }; opened.push(tx); await work(tx as never); };
    await archiveOrphanMarker(archive, open)(attempts, "Error: rolled back");
    expect(orphans).toEqual([{ tx: opened[0], attempts, reason: "Error: rolled back" }]);
    const { orphaned: _hook, ...withoutHook } = archive;
    await archiveOrphanMarker(withoutHook, open)(attempts, "Error: rolled back");
    await archiveOrphanMarker(null, open)(attempts, "Error: rolled back");
    expect(opened).toHaveLength(1);
  });
});

describe("vitalité du lien : une ancre annulée laisse un orphelin marqué", () => {
  const link: LinkIdentity = { runtimeId: RT, organizationId: ORG, tokenHash: "hash", expiresAt: null };
  const frame = { t: "audit.anchor" as const, runtimeId: RT, keyId: "k-1", writeSeq: 3, count: 2, dropped: 0, tail: "a".repeat(64) };
  const other = (sql: string) => {
    if (sql.includes("from runtime_audit_keys")) return [{ keyId: "k-1" }];
    if (sql.includes("insert into runtime_audit_anchors")) return [{ runtimeId: RT }];
    return undefined;
  };

  test("bloquant : AuditAnchorError, aucun maillon, l'objet est marqué sous le contexte du lien", async () => {
    const { db, rows, statements } = chainDb({ other });
    const { archive, orphans } = failingArchive();
    const store = createLinkLivenessStore(db, { archive, anchorBlocking: async () => true });
    await expect(store.auditAnchor!(link, frame)).rejects.toBeInstanceOf(AuditAnchorError);
    expect(rows).toHaveLength(0);
    expect(orphans.map((entry) => entry.attempts)).toEqual([[
      { organizationId: ORG, runtimeId: RT, kind: "runtime_anchor", objectKey: anchorObjectKey(RT, 3), anchorId: "worm:memory", written: "unknown" },
    ]]);
    expect(orphans[0]!.tx).toBeDefined();
    expect(statements.some((entry) => entry.sql.includes("audit_worm_orphans"))).toBe(false);
  });

  test("enregistrée : aucun marquage", async () => {
    const { db, statements } = chainDb({ other });
    const store = createLinkLivenessStore(db, { archive: new MemoryAuditArchive() });
    expect(await store.auditAnchor!(link, frame)).toBe("recorded");
    expect(statements.some((entry) => entry.sql.includes("audit_worm_orphans"))).toBe(false);
  });
});

describe("migration 0153", () => {
  const root = join(import.meta.dir, "../../..");
  const sql = readFileSync(join(root, "db/migrations/0153_audit_worm_orphans.sql"), "utf8");

  test("append-only (trigger, aucune grant update/delete), RLS forcée, enregistrée et attribuée", () => {
    expect(sql).toContain("create trigger audit_worm_orphans_no_update before update on audit_worm_orphans");
    expect(sql).toContain("alter table audit_worm_orphans force row level security;");
    expect(sql).toContain("grant select, insert on audit_worm_orphans to openedbot_api;");
    expect(sql).toContain("grant select on audit_worm_orphans to openedbot_worker;"); // retirée par 0154
    expect(sql).not.toMatch(/grant[^;]*\b(update|delete)\b[^;]*audit_worm_orphans/i);
    expect(sql).toContain("('0153_audit_worm_orphans')");
    // The table stays in the core schema (applied in production) but belongs
    // to the external archive: the core neither reads nor writes it.
    const ownership = JSON.parse(readFileSync(join(root, "db/ownership.json"), "utf8")) as Record<string, { owner?: string }>;
    expect(ownership.audit_worm_orphans?.owner).toBe("audit");
  });
});
