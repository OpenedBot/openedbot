import { describe, expect, test } from "bun:test";
import { decodeTextFrame, RELAY_CLOSE_REVOKED } from "@openedbot/contracts-connector";
import type { Db } from "@openedbot/platform-db";
import { RuntimeLinkBroker, createLinkLivenessStore, type LinkIdentity } from "@openedbot/runtime-link/application/broker";

const link: LinkIdentity = { runtimeId: "runtime-1", organizationId: "org-1", tokenHash: "hash-1", expiresAt: null };
async function settle() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }

function fixtureDb(revocable = true) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    statements.push({ sql, values });
    if (sql.includes("update runtimes set revoked_at")) return revocable ? [{ id: link.runtimeId }] : [];
    return [];
  }) as unknown as Bun.TransactionSQL;
  const db = { begin: async (callback: (tx: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as Db;
  return { db, statements };
}

function openBroker(retire: (link: LinkIdentity) => Promise<void>) {
  const sent: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const broker = new RuntimeLinkBroker({ instanceId: "api-test", log: () => {}, liveness: {
    connected: async () => {}, seen: async () => {}, disconnected: async () => {}, retire,
  } });
  const connection = broker.open({
    send: (raw) => { if (typeof raw === "string") sent.push(raw); return 1; },
    close(code: number, reason: string) { closes.push({ code, reason }); },
  });
  return { broker, connection, sent, closes };
}

describe("runtime link retire (host uninstall)", () => {
  test("wire: link.retire carries nothing, link.retired names the runtime", () => {
    expect(decodeTextFrame(JSON.stringify({ t: "link.retire" }))).toEqual({ t: "link.retire" });
    expect(decodeTextFrame(JSON.stringify({ t: "link.retired", runtimeId: "runtime-1" }))).toEqual({ t: "link.retired", runtimeId: "runtime-1" });
    expect(() => decodeTextFrame(JSON.stringify({ t: "link.retired" }))).toThrow();
  });

  test("persistence revokes the runtime of the current token only, and journals it", async () => {
    const fixture = fixtureDb();
    await createLinkLivenessStore(fixture.db).retire!({ ...link, generation: "7" }, "api-first");
    const update = fixture.statements.find(({ sql }) => sql.includes("update runtimes set revoked_at"))!;
    expect(update.sql).toContain("is_active = false");
    expect(update.sql).toContain("revoked_at is null");
    expect(update.values).toEqual([link.runtimeId, link.organizationId, link.tokenHash]);
    const event = fixture.statements.find(({ sql }) => sql.includes("insert into runtime_link_events"))!;
    expect(event.values).toContain("revoked");
    expect(fixture.statements.some(({ sql, values }) => sql.includes("app.organization_id") && values[0] === link.organizationId)).toBe(true);
    const gone = fixtureDb(false);
    await expect(createLinkLivenessStore(gone.db).retire!(link)).rejects.toThrow();
    expect(gone.statements.some(({ sql }) => sql.includes("insert into runtime_link_events"))).toBe(false);
  });

  test("an admitted link is revoked, acknowledged, then closed 4004", async () => {
    const retired: string[] = [];
    const { broker, connection, sent, closes } = openBroker(async (identity) => { retired.push(identity.runtimeId); });
    connection.handleText({ t: "link.retire" });
    await settle();
    expect(retired).toEqual([]);
    broker.bind(connection, link);
    connection.handleText({ t: "link.retire" });
    connection.handleText({ t: "link.retire" });
    await settle();
    expect(retired).toEqual(["runtime-1"]);
    expect(sent.map((raw) => decodeTextFrame(raw))).toEqual([{ t: "link.retired", runtimeId: "runtime-1" }]);
    expect(closes).toEqual([{ code: RELAY_CLOSE_REVOKED, reason: "LINK_RETIRED" }]);
    broker.closeAll();
  });

  test("the previous token of a rotation cannot retire the runtime", async () => {
    const retired: string[] = [];
    const { broker, connection, sent } = openBroker(async (identity) => { retired.push(identity.runtimeId); });
    broker.bind(connection, { ...link, expiresAt: Date.now() + 60_000 });
    connection.handleText({ t: "link.retire" });
    await settle();
    expect(retired).toEqual([]);
    expect(sent).toEqual([]);
    broker.closeAll();
  });

  test("a failed revocation sends no acknowledgement and keeps the link open", async () => {
    const { broker, connection, sent } = openBroker(async () => { throw new Error("db down"); });
    broker.bind(connection, link);
    connection.handleText({ t: "link.retire" });
    await settle();
    expect(sent).toEqual([]);
    expect(connection.isClosed).toBe(false);
    broker.closeAll();
  });
});
