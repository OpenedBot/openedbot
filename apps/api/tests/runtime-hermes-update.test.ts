import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { readFileSync } from "node:fs";
import { decodeTextFrame, type RelayTextFrame } from "@openedbot/contracts-connector";
import { EDGE_SETUP_HERMES_VERSION } from "@openedbot/platform-config/connector-version";
import { RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import { readApiConfig } from "../src/infrastructure/config";
import { createRuntimeLinkGateway, type LinkSocketData } from "../src/routes/runtimes/runtime-link-routes";
import { publicRuntime, type RuntimeRow } from "../src/routes/runtimes/runtime-routes";

const config = () => readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") });

/** Le `update ... set link_agent` écrit après admission, SQL en mémoire. */
async function helloWrite(hello: Record<string, unknown>): Promise<unknown[] | undefined> {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const frames: RelayTextFrame[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ sql: strings.join(" ? "), values });
    return [];
  }) as unknown as Bun.TransactionSQL;
  const db = { begin: async (callback: (tx: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as SQL;
  const broker = new RuntimeLinkBroker({
    instanceId: "hermes-version-test", log: () => {},
    liveness: { reserveGeneration: async () => "7", connected: async () => {}, seen: async () => {}, disconnected: async () => {}, event: async () => {} },
  });
  const gateway = createRuntimeLinkGateway({ db, config: config(), broker, log: () => {} });
  const ws = {
    data: {
      credential: { kind: "link", identity: { runtimeId: "rt", organizationId: "org", tokenHash: "hash", expiresAt: null } },
      peer: { ip: "203.0.113.7", agent: "http-agent" }, state: "awaiting_hello", connection: null, helloTimer: null,
    } as LinkSocketData,
    send: (data: string | Uint8Array) => { if (typeof data === "string") frames.push(decodeTextFrame(data)); return 1; },
    close: () => {},
  };
  try {
    gateway.websocket.message(ws, JSON.stringify({ t: "hello", protocol: 1, ...hello }));
    for (let attempt = 0; attempt < 100 && !frames.some((frame) => frame.t === "link.context"); attempt++) await Bun.sleep(1);
    const write = statements.find(({ sql }) => sql.includes("set link_agent ="));
    expect(write?.sql).toContain("link_hermes_version =");
    return write?.values;
  } finally {
    broker.closeAll();
  }
}

describe("hello.hermesVersion", () => {
  test("is written with the agent, under the same lease", async () => {
    expect(await helloWrite({ agent: "edge-setup/v0.6.0", hermesVersion: "0.22.2" }))
      .toEqual(["edge-setup/v0.6.0", "0.22.2", "rt", "org", "7", "hash", "hash"]);
  });

  test("is bounded to 64 characters, and cleared when hello carries none", async () => {
    expect((await helloWrite({ agent: "edge-setup/v0.6.0", hermesVersion: "9".repeat(200) }))?.[1]).toBe("9".repeat(64));
    expect((await helloWrite({ agent: "edge-setup/v0.6.0" }))?.[1]).toBeNull();
  });
});

describe("link.hermesUpdate", () => {
  const row = {
    reachability: "connector", linkConnectedAt: null, linkFeatures: [],
    linkAgent: "edge-setup/v0.6.0", linkAgentSeenAt: null, linkHermesVersion: "0.22.2",
  } as unknown as RuntimeRow;

  test("says a newer Hermes ships with the latest edge-setup release", () => {
    expect(publicRuntime(row, "disabled", [], { hermesVersion: "0.22.6" }).link?.hermesUpdate).toEqual({
      current: "0.22.2", latest: "0.22.6", available: true, upgradeCommand: "sudo edge-setup upgrade --yes",
    });
  });

  test("without the anchor's value, compares with the Hermes pinned by this repository", () => {
    expect(publicRuntime({ ...row, linkHermesVersion: EDGE_SETUP_HERMES_VERSION }, "disabled").link?.hermesUpdate)
      .toMatchObject({ latest: EDGE_SETUP_HERMES_VERSION, available: false });
    expect(publicRuntime({ ...row, linkHermesVersion: "0.1.0" }, "disabled").link?.hermesUpdate)
      .toMatchObject({ current: "0.1.0", latest: EDGE_SETUP_HERMES_VERSION, available: true });
  });

  test("a canary or a malformed announced version never raises it; nothing announced, no block", () => {
    for (const announced of ["0.22.5+canary.20261101", "hermes"]) {
      expect(publicRuntime({ ...row, linkHermesVersion: announced }, "disabled", [], { hermesVersion: "0.22.6" }).link?.hermesUpdate)
        .toMatchObject({ current: null, available: false });
    }
    expect(publicRuntime({ ...row, linkHermesVersion: null }, "disabled", [], { hermesVersion: "0.22.6" }).link?.hermesUpdate).toBeNull();
    expect(publicRuntime({ ...row, linkHermesVersion: undefined }, "disabled").link?.hermesUpdate).toBeNull();
  });

  test("0162 adds one bounded nullable column, in a transaction", () => {
    const sql = readFileSync(new URL("../../../db/migrations/0162_runtime_link_hermes_version.sql", import.meta.url), "utf8");
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("add column if not exists link_hermes_version text null");
    expect(sql).toContain("char_length(link_hermes_version) <= 64");
    expect(sql).toContain("comment on column runtimes.link_hermes_version is");
    expect(sql).toContain("insert into schema_migrations(version) values ('0162_runtime_link_hermes_version')");
    expect(sql).not.toMatch(/drop table|disable row level security|grant .*public/i);
  });
});
