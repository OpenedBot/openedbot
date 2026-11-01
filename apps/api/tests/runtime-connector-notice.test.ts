import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { decodeTextFrame, type RelayTextFrame } from "@openedbot/contracts-connector";
import { readApiConfig } from "../src/infrastructure/config";
import { RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import { createRuntimeLinkGateway, type LinkSocketData } from "../src/routes/runtimes/runtime-link-routes";

const THRESHOLDS = { RUNTIME_CONNECTOR_MIN_VERSION: "v0.5.7", RUNTIME_CONNECTOR_LATEST_VERSION: "v0.5.7" };
const config = () => readApiConfig({
  OPENEDBOT_ENV: "test",
  RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  WEB_APP_URL: "https://console.example.test",
  ...THRESHOLDS,
});

type Statement = { sql: string; values: unknown[] };

/**
 * In-memory SQL that keeps the unique notice key across sessions, like the
 * `unique (runtime_id, installed_version, target_version)` of 0101.
 */
function store(options: { failNotice?: boolean } = {}) {
  const notices = new Set<string>();
  return {
    notices,
    session(statements: Statement[]) {
      const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join(" ? ").replace(/\s+/g, " ");
        statements.push({ sql, values });
        if (sql.includes("insert into runtime_connector_notices")) {
          if (options.failNotice) throw new Error("notice table unavailable");
          const key = values.slice(1, 4).join("|");
          const fresh = !notices.has(key);
          notices.add(key);
          return Object.assign([], { count: fresh ? 1 : 0 });
        }
        if (sql.includes("from runtimes r join organizations o")) return [{ runtimeName: "VPS production", workspace: "atelier" }];
        if (sql.includes("from memberships m join users u")) return [{ userId: "owner-1", email: "owner@example.test" }];
        if (sql.includes("insert into email_outbox")) return Object.assign([], { count: 1 });
        return Object.assign([], { count: 0 });
      }) as unknown as Bun.TransactionSQL;
      return { begin: async (callback: (inner: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as SQL;
    },
  };
}

async function hello(db: ReturnType<typeof store>, agent: string) {
  const statements: Statement[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const frames: RelayTextFrame[] = [];
  const closed: number[] = [];
  const broker = new RuntimeLinkBroker({
    instanceId: "connector-notice-test", log: () => {},
    liveness: {
      reserveGeneration: async () => "42",
      connected: async () => {}, seen: async () => {}, disconnected: async () => {}, event: async () => {},
    },
  });
  const gateway = createRuntimeLinkGateway({
    db: db.session(statements), config: config(), broker,
    log: (event, fields) => { logs.push({ event, fields }); },
  });
  const ws = {
    data: {
      credential: { kind: "link", identity: { runtimeId: "rt", organizationId: "org", tokenHash: "hash", expiresAt: null } },
      peer: { ip: "203.0.113.7", agent: "http-agent" }, state: "awaiting_hello", connection: null, helloTimer: null,
    } as LinkSocketData,
    send: (data: string | Uint8Array) => { if (typeof data === "string") frames.push(decodeTextFrame(data)); return 1; },
    close: (code = 1000) => { closed.push(code); },
  };
  try {
    gateway.websocket.message(ws, JSON.stringify({ t: "hello", protocol: 1, agent }));
    for (let attempt = 0; attempt < 100 && !frames.some((frame) => frame.t === "link.context") && !closed.length; attempt++) await Bun.sleep(1);
    return {
      statements, logs, frames, closed: [...closed], bound: broker.connected("rt"),
      emails: statements.filter(({ sql }) => sql.includes("insert into email_outbox")),
      notices: statements.filter(({ sql }) => sql.includes("insert into runtime_connector_notices")),
    };
  } finally {
    broker.closeAll();
  }
}

describe("outdated connector owner notice", () => {
  test("an outdated agent writes one notice and one e-mail per owner, with versions, command and settings link", async () => {
    const db = store();
    const session = await hello(db, "edge-setup/v0.5.3");
    expect(session.bound).toBe(true);
    expect(session.notices).toHaveLength(1);
    expect(session.notices[0]!.values).toEqual(["org", "rt", "v0.5.3", "v0.5.7"]);
    expect(session.emails).toHaveLength(1);
    const [, kind, dedupeKey, recipient, locale, payload] = session.emails[0]!.values;
    expect(kind).toBe("runtime_connector_outdated");
    expect(dedupeKey).toBe("runtime_connector_outdated:rt:v0.5.3:v0.5.7:owner-1");
    expect(recipient).toBe("owner@example.test");
    expect(locale).toBe("fr");
    expect(payload).toEqual({
      runtimeName: "VPS production",
      installedVersion: "v0.5.3",
      targetVersion: "v0.5.7",
      latestVersion: "v0.5.7",
      upgradeCommand: "sudo edge-setup upgrade --yes",
      settingsUrl: "https://console.example.test/o/atelier/settings/runtime",
      webAppUrl: "https://console.example.test",
    });
    const queued = session.logs.find(({ event }) => event === "runtime_link.connector_notice_queued");
    expect(queued?.fields).toEqual({ runtimeId: "rt", installed: "v0.5.3", target: "v0.5.7", emails: 1 });
    expect(JSON.stringify(session.logs)).not.toContain("owner@example.test");
  });

  test("a second connection with the same versions enqueues nothing", async () => {
    const db = store();
    await hello(db, "edge-setup/v0.5.3");
    const again = await hello(db, "edge-setup/v0.5.3");
    expect(again.bound).toBe(true);
    expect(again.notices).toHaveLength(1);
    expect(again.emails).toHaveLength(0);
    expect(again.logs.some(({ event }) => event === "runtime_link.connector_notice_queued")).toBe(false);
  });

  test("an up-to-date agent enqueues nothing", async () => {
    for (const agent of ["edge-setup/v0.5.7", "edge-setup/v0.6.0", "edge-setup/v0.5.3-dirty"]) {
      const session = await hello(store(), agent);
      expect(session.bound).toBe(true);
      expect(session.notices).toHaveLength(0);
      expect(session.emails).toHaveLength(0);
    }
  });

  test("a notice failure is logged and the session stays admitted", async () => {
    const session = await hello(store({ failNotice: true }), "edge-setup/v0.5.3");
    expect(session.bound).toBe(true);
    expect(session.closed).toHaveLength(0);
    expect(session.frames.some((frame) => frame.t === "link.context")).toBe(true);
    expect(session.emails).toHaveLength(0);
    expect(session.logs).toContainEqual({
      event: "runtime_link.connector_notice_failed",
      fields: { runtimeId: "rt", error: "Error: notice table unavailable" },
    });
  });
});
