import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  anchorObjectKey,
  anchorRecordBytes,
  isValidWormObjectKey,
  MemoryAuditArchive,
  parseWormAnchor,
  sameAnchor,
  verdictObjectKey,
  type AuditArchive,
  type WormAnchorRecord,
} from "../src/application/audit-worm";
import { createLinkLivenessStore, type LinkIdentity } from "../src/application/broker";

/**
 * L'archive externe (port `auditArchive` du plug-in `audit`) : un objet se
 * dépose une fois et ne se réécrit jamais ; une ancre enregistrée en base y
 * part dans sa transaction ; un dépôt qui échoue se journalise sans casser le
 * lien. Sans archive, rien ne part.
 */
const RUNTIME_ID = "8f3b2c1d-1111-4222-8333-444455556666";
const VERDICT_ID = "0c0d0e0f-1011-4213-9415-161718191a1b";
const ORG_ID = "0b9c6a1e-0000-4000-8000-000000000001";
const record: WormAnchorRecord = { runtimeId: RUNTIME_ID, keyId: "k-1", writeSeq: 3, count: 2, dropped: 0, tail: "a".repeat(64), receivedAt: "2026-09-06T12:00:07.000Z" };

describe("archive mémoire write-once", () => {
  test("écrit une fois, ne réécrit jamais", async () => {
    const archive = new MemoryAuditArchive();
    const key = anchorObjectKey(RUNTIME_ID, 3);
    const deposit = (bytes: number[]) => archive.put(null, { organizationId: ORG_ID, runtimeId: RUNTIME_ID, kind: "runtime_anchor", objectKey: key, bytes: new Uint8Array(bytes) });
    await deposit([1, 2, 3]);
    await deposit([9]);
    expect([...(await archive.get(key))!]).toEqual([1, 2, 3]);
    expect(await archive.get(anchorObjectKey(RUNTIME_ID, 4))).toBeNull();
    expect(archive.keys()).toEqual([key]);
    expect(archive.id).toBe("worm:memory");
  });

  test("les clés d'objets sont bornées à audit/<runtime>/anchors|verdicts", async () => {
    expect(anchorObjectKey(RUNTIME_ID, 3)).toBe(`audit/${RUNTIME_ID}/anchors/000000000003.json`);
    expect(verdictObjectKey(RUNTIME_ID, VERDICT_ID)).toBe(`audit/${RUNTIME_ID}/verdicts/${VERDICT_ID}.json`);
    expect(() => anchorObjectKey("not-a-uuid", 3)).toThrow(/runtime id/);
    expect(() => anchorObjectKey(RUNTIME_ID, -1)).toThrow(/writeSeq/);
    expect(() => verdictObjectKey(RUNTIME_ID, "../escape")).toThrow(/identity/);
    expect(isValidWormObjectKey(`audit/${RUNTIME_ID}/anchors/000000000003.json`)).toBe(true);
    expect(isValidWormObjectKey(`audit/${RUNTIME_ID}/../anchors/000000000003.json`)).toBe(false);
    await expect(new MemoryAuditArchive().get("org/x")).rejects.toThrow(/object key/);
  });
});

describe("ancre archivée", () => {
  test("octets canoniques, relecture stricte, comparaison sans receivedAt", () => {
    const bytes = anchorRecordBytes(record);
    expect(new TextDecoder().decode(bytes)).toBe(`{"count":2,"dropped":0,"keyId":"k-1","receivedAt":"2026-09-06T12:00:07.000Z","runtimeId":"${RUNTIME_ID}","tail":"${"a".repeat(64)}","writeSeq":3}`);
    expect(parseWormAnchor(bytes)).toEqual(record);
    expect(parseWormAnchor(new TextEncoder().encode("not json"))).toBeNull();
    expect(parseWormAnchor(new TextEncoder().encode(JSON.stringify({ ...record, tail: "short" })))).toBeNull();
    expect(parseWormAnchor(new TextEncoder().encode(JSON.stringify({ ...record, writeSeq: "3" })))).toBeNull();
    const { receivedAt: _later, ...position } = { ...record, receivedAt: "2030-01-01T00:00:00Z" };
    expect(sameAnchor(record, position)).toBe(true);
    expect(sameAnchor(record, { ...record, tail: "b".repeat(64) })).toBe(false);
    expect(sameAnchor(record, { ...record, keyId: "k-2" })).toBe(false);
  });
});

type Statement = { sql: string; values: unknown[] };

/** Une base factice : la clé est connue, l'ancre s'enregistre (ou recule), les événements du lien se journalisent. */
function fakeDb(statements: Statement[], options: { regressed?: boolean } = {}): SQL {
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    statements.push({ sql, values });
    if (sql.includes("from runtime_audit_keys")) return [{ keyId: "k-1" }];
    if (sql.includes("insert into runtime_audit_anchors")) return options.regressed ? [] : [{ runtimeId: RUNTIME_ID }];
    return [];
  }) as unknown as SQL;
  return { begin: async (callback: (inner: Bun.TransactionSQL) => Promise<unknown>) => callback(tx as unknown as Bun.TransactionSQL) } as unknown as SQL;
}

const link: LinkIdentity = { runtimeId: RUNTIME_ID, organizationId: "org-1", tokenHash: "hash", expiresAt: null };
const frame = { t: "audit.anchor" as const, runtimeId: RUNTIME_ID, keyId: "k-1", writeSeq: 3, count: 2, dropped: 0, tail: "a".repeat(64) };

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("vitalité du lien : ancre déposée une fois enregistrée", () => {
  test("une ancre enregistrée est déposée une fois, avec l'heure de réception", async () => {
    const statements: Statement[] = [];
    const worm = new MemoryAuditArchive();
    const store = createLinkLivenessStore(fakeDb(statements), { archive: worm, now: () => new Date("2026-09-06T12:00:07Z") });
    expect(await store.auditAnchor!(link, frame)).toBe("recorded");
    await settle();
    expect(worm.keys()).toEqual([anchorObjectKey(RUNTIME_ID, 3)]);
    expect(parseWormAnchor((await worm.get(anchorObjectKey(RUNTIME_ID, 3)))!)).toEqual({ ...record, receivedAt: "2026-09-06T12:00:07.000Z" });
    expect(statements.some((entry) => entry.sql.includes("insert into runtime_link_events"))).toBe(false);
  });

  test("une ancre en recul n'est pas déposée ; sans store rien ne part", async () => {
    const worm = new MemoryAuditArchive();
    expect(await createLinkLivenessStore(fakeDb([], { regressed: true }), { archive: worm }).auditAnchor!(link, frame)).toBe("regressed");
    expect(await createLinkLivenessStore(fakeDb([])).auditAnchor!(link, frame)).toBe("recorded");
    await settle();
    expect(worm.keys()).toEqual([]);
  });

  test("un dépôt qui échoue journalise worm_write_failed et ne fait pas échouer l'ancre", async () => {
    const statements: Statement[] = [];
    const failing: AuditArchive = { id: "worm:memory", put: async () => { throw new Error("bucket unreachable"); }, get: async () => null };
    const store = createLinkLivenessStore(fakeDb(statements), { archive: failing });
    expect(await store.auditAnchor!(link, frame)).toBe("recorded");
    await settle();
    const event = statements.find((entry) => entry.sql.includes("insert into runtime_link_events"));
    expect(event?.values[2]).toBe("worm_write_failed");
    expect(event?.values[6]).toMatchObject({ reason: "anchor", keyId: "k-1", writeSeq: 3 });
  });
});
