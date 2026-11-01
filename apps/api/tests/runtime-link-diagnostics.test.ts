import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { decodeTextFrame, type RelayDiagnosticFrame } from "@openedbot/contracts-connector";
import type { Db } from "@openedbot/platform-db";
import type { ApiConfig } from "../src/infrastructure/config";
import { RuntimeLinkBroker, createLinkLivenessStore, type LinkIdentity } from "@openedbot/runtime-link/application/broker";
import { sanitizeDiagnosticText } from "@openedbot/runtime-link/domain/diagnostics";
import { NO_RUNTIME_LINKS } from "@openedbot/runtime-link/application/dialer";
import { runtimeRoutes } from "../src/routes/runtimes/runtime-routes";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";

const frame: RelayDiagnosticFrame = {
  t: "diagnostic", eventId: "b5fe588c-02f8-4fa8-a83c-e7097cec41c4", component: "operator",
  state: "unavailable", code: "OPERATOR_UNAVAILABLE", occurredAt: "2026-09-05T18:00:00Z",
  message: "Operator capability request failed", stack: "connector.readOperatorFeatures\nclient.go:124",
};
const link: LinkIdentity = { runtimeId: "runtime-1", organizationId: "org-1", tokenHash: "hash-1", expiresAt: null };
async function settle() { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); }

function fixtureDb(allowed = true) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const events = new Map<string, unknown[]>();
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    statements.push({ sql, values });
    if (sql.includes("select id from runtimes")) return allowed ? [{ id: link.runtimeId }] : [];
    if (sql.includes("insert into runtime_link_diagnostics")) {
      if (!events.has(String(values[2]))) events.set(String(values[2]), values);
    }
    if (sql.includes("from runtime_link_diagnostics")) return [];
    return [];
  }) as unknown as Bun.TransactionSQL;
  const db = { begin: async (callback: (tx: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as Db;
  return { db, statements, events };
}

describe("runtime link diagnostics", () => {
  test("wire validation bounds UTF-8 text and rejects invalid metadata", () => {
    expect(decodeTextFrame(JSON.stringify(frame))).toEqual(frame);
    for (const patch of [{ message: "é".repeat(129) }, { stack: "x".repeat(8193) }, { eventId: "invalid" },
      { state: "failed" }, { component: "shell" }, { code: "arbitrary text" }, { occurredAt: "yesterday" }]) {
      expect(() => decodeTextFrame(JSON.stringify({ ...frame, ...patch }))).toThrow();
    }
    expect(decodeTextFrame(JSON.stringify({ t: "diagnostic.ack", eventId: frame.eventId })).t).toBe("diagnostic.ack");
  });

  test("persistence is tenant/runtime scoped, idempotent and redacts secrets without fabricating stacks", async () => {
    const fixture = fixtureDb();
    const store = createLinkLivenessStore(fixture.db);
    const sensitive = { ...frame, message: "Bearer secret-value", stack: "readCapabilities\napi_key=secret-value\nclient.go:124" };
    await store.diagnostic!({ ...link, generation: "41" }, sensitive, "api-first");
    await store.diagnostic!({ ...link, generation: "42" }, sensitive, "api-retry");
    expect(fixture.events.size).toBe(1);
    const stored = [...fixture.events.values()][0]!;
    expect(stored.slice(9)).toEqual(["api-first", "41"]);
    expect(stored[6]).toBe("Bearer [redacted]");
    expect(stored[7]).toBe("readCapabilities\napi_key=[redacted]\nclient.go:124");
    expect(fixture.statements.some(({ sql, values }) => sql.includes("app.organization_id") && values[0] === link.organizationId)).toBe(true);
    expect(fixture.statements.find(({ sql }) => sql.includes("select id from runtimes"))?.values)
      .toContain(link.tokenHash);
    const denied = fixtureDb(false);
    await expect(createLinkLivenessStore(denied.db).diagnostic!(link, frame)).rejects.toThrow();
    expect(denied.events.size).toBe(0);
    const { stack: _stack, ...withoutStack } = frame;
    await store.diagnostic!(link, { ...withoutStack, eventId: "ce625abb-fb81-4759-aa86-0086b36d33c2" });
    expect([...fixture.events.values()][1]![7]).toBeNull();
    expect(new TextEncoder().encode(sanitizeDiagnosticText("é".repeat(200), 255)).byteLength).toBe(254);
  });

  test("ACK follows durable success; before-bind, saturation, duplicate-in-flight and SQL failure never ACK", async () => {
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    let fail = false;
    const broker = new RuntimeLinkBroker({ instanceId: "api-test", log: () => {}, liveness: {
      connected: async () => {}, seen: async () => {}, disconnected: async () => {},
      diagnostic: async () => { writes++; await gate; if (fail) throw new Error("db down"); },
    } });
    const connection = broker.open({ send: (raw) => { if (typeof raw === "string") sent.push(raw); return 1; }, close() {} });
    connection.handleText(frame);
    expect(writes).toBe(0);
    broker.bind(connection, link);
    connection.handleText(frame);
    connection.handleText(frame);
    for (let index = 1; index <= 4; index++) connection.handleText({ ...frame, eventId: `b5fe588c-02f8-4fa8-a83c-e7097cec41c${index}` });
    expect(writes).toBe(4);
    expect(sent).toHaveLength(0);
    release();
    await settle();
    expect(sent.map((raw) => decodeTextFrame(raw).t)).toEqual(Array(4).fill("diagnostic.ack"));
    connection.handleText(frame);
    await settle();
    expect(sent).toHaveLength(5);
    fail = true;
    connection.handleText(frame);
    await settle();
    expect(sent).toHaveLength(5);
    expect(connection.isClosed).toBe(false);
    broker.closeAll();
  });

  test("reading diagnostics requires owner/admin, bounds limits and scopes runtime and tenant", async () => {
    const fixture = fixtureDb();
    const mount = (role: AuthContext["role"]) => {
      const app = new Hono<{ Variables: AppVariables }>();
      app.use("*", async (context, next) => {
        context.set("auth", { sessionId: "session", organizationId: link.organizationId, userId: "user", role, kind: "web", credentialHash: "hash" });
        await next();
      });
      app.onError((error) => Response.json({ error: "request failed" }, { status: error instanceof HttpError ? error.status : 500 }));
      app.route("/", runtimeRoutes(fixture.db, {} as ApiConfig, NO_RUNTIME_LINKS));
      return app;
    };
    expect((await mount("member").request("/runtime-1/diagnostics")).status).toBe(403);
    expect((await mount("owner").request("/runtime-1/diagnostics?limit=101")).status).toBe(400);
    expect((await mount("admin").request("/runtime-1/diagnostics?limit=10")).status).toBe(200);
    expect(fixture.statements.find(({ sql }) => sql.includes("from runtime_link_diagnostics"))?.values)
      .toEqual([link.organizationId, link.runtimeId, 10]);
  });
});
