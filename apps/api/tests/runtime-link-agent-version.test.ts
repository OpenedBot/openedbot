import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { readFileSync } from "node:fs";
import { decodeTextFrame, RELAY_MAX_FEATURES, type RelayTextFrame } from "@openedbot/contracts-connector";
import { readApiConfig } from "../src/infrastructure/config";
import { connectorVersionBelow, parseConnectorVersion, runtimeConnector } from "@openedbot/platform-config/connector-version";
import { insertRuntimeLinkEvent, RuntimeLinkBroker, type LinkEventKind, type LinkEventMeta } from "@openedbot/runtime-link/application/broker";
import { createRuntimeLinkGateway, type LinkSocketData } from "../src/routes/runtimes/runtime-link-routes";
import { publicRuntime, type RuntimeRow } from "../src/routes/runtimes/runtime-routes";

const versions = { minimumVersion: "v0.2.0", latestVersion: "v0.3.0" };
const seenAt = "2026-09-06T22:00:00.000Z";
const config = (env: Record<string, string> = {}) => readApiConfig({
  OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), ...env,
});

describe("versions du connecteur", () => {
  test("normalise major.minor.patch avec ou sans préfixe v", () => {
    expect(parseConnectorVersion("0.2.0")).toBe("v0.2.0");
    expect(parseConnectorVersion("v12.10.3")).toBe("v12.10.3");
  });

  test("ignore versions inconnues, pré-release, dirty et formes non semver", () => {
    for (const version of [null, undefined, "", "5430f9c-dirty", "v0.2.0-dirty", "v0.2.0-rc.1", "v0.2.0+build", "v0.2", "v01.2.3", "v1.2.3\n"]) {
      expect(parseConnectorVersion(version)).toBeNull();
      expect(connectorVersionBelow(version, "v1.0.0")).toBe(false);
    }
    expect(runtimeConnector("other/v0.1.0", seenAt, versions)?.version).toBeNull();
  });

  test("compare numériquement major puis minor puis patch, égalité exclue", () => {
    for (const [older, newer] of [["v0.9.9", "v1.0.0"], ["v1.9.99", "v1.10.0"], ["v1.2.9", "v1.2.10"], ["v9007199254740992.0.0", "v9007199254740993.0.0"]]) {
      expect(connectorVersionBelow(older, newer)).toBe(true);
      expect(connectorVersionBelow(newer, older)).toBe(false);
    }
    expect(connectorVersionBelow("0.2.0", "v0.2.0")).toBe(false);
    expect(connectorVersionBelow("v0.1.0", "invalid")).toBe(false);
  });

  test("sans variables, la version déclarée reste visible et aucun signalement", () => {
    expect(config().connectorVersions).toEqual({ minimumVersion: null, latestVersion: null });
    expect(runtimeConnector("hermes-setup/v0.1.0", seenAt)).toMatchObject({
      version: "v0.1.0", minimumVersion: null, latestVersion: null, outdated: false, updateAvailable: false,
    });
  });

  test("le préfixe edge-setup (canonique depuis le renommage) est reconnu comme hermes-setup (agents déjà déployés)", () => {
    expect(runtimeConnector("edge-setup/v0.4.0", seenAt)).toMatchObject({ version: "v0.4.0" });
    expect(runtimeConnector("hermes-setup/v0.1.0", seenAt)).toMatchObject({ version: "v0.1.0" });
  });

  test("chaque seuil est facultatif et indépendant", () => {
    expect(runtimeConnector("hermes-setup/v0.1.0", seenAt, { minimumVersion: "v0.2.0" }))
      .toMatchObject({ outdated: true, updateAvailable: false, latestVersion: null });
    expect(runtimeConnector("hermes-setup/v0.1.0", seenAt, { latestVersion: "v0.2.0" }))
      .toMatchObject({ outdated: false, updateAvailable: true, minimumVersion: null });
    expect(runtimeConnector("hermes-setup/v0.2.0", seenAt, versions))
      .toMatchObject({ outdated: false, updateAvailable: true });
    expect(runtimeConnector("hermes-setup/v0.3.0", seenAt, versions))
      .toMatchObject({ outdated: false, updateAvailable: false });
  });

  test("la configuration expose les seuils et rejette une valeur non stable", () => {
    expect(config({ RUNTIME_CONNECTOR_MIN_VERSION: "0.2.0", RUNTIME_CONNECTOR_LATEST_VERSION: "v0.3.0" }).connectorVersions).toEqual(versions);
    for (const name of ["RUNTIME_CONNECTOR_MIN_VERSION", "RUNTIME_CONNECTOR_LATEST_VERSION"]) {
      expect(() => config({ [name]: "v0.2.0-dirty" })).toThrow(name);
    }
  });

  test("le DTO expose la dernière déclaration même déconnecté, sinon null", () => {
    const row = { reachability: "connector", linkConnectedAt: null, linkFeatures: [], linkAgent: "hermes-setup/v0.1.0", linkAgentSeenAt: new Date(seenAt) } as unknown as RuntimeRow;
    expect(publicRuntime(row, "disabled", [], versions).link).toMatchObject({
      connected: false,
      connector: { agent: row.linkAgent, version: "v0.1.0", ...versions, seenAt, outdated: true, updateAvailable: true, upgradeCommand: "sudo edge-setup upgrade --yes" },
    });
    expect(publicRuntime({ ...row, linkAgent: null }, "disabled", [], versions).link?.connector).toBeNull();
  });
});

/** Appel direct des handlers avec transport et SQL en mémoire : aucun serveur. */
async function hello(agent?: string, env: Record<string, string> = {}, failWrite = false) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const events: Array<{ kind: LinkEventKind; meta: LinkEventMeta }> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const frames: RelayTextFrame[] = [];
  const closed: number[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ? ");
    statements.push({ sql, values });
    if (failWrite && sql.includes("set link_agent =")) throw new Error("écriture indisponible");
    return [];
  }) as unknown as Bun.TransactionSQL;
  const db = { begin: async (callback: (tx: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as SQL;
  const broker = new RuntimeLinkBroker({
    instanceId: "agent-version-test", log: () => {},
    liveness: {
      reserveGeneration: async () => "42",
      connected: async () => {}, seen: async () => {}, disconnected: async () => {},
      event: async (_identity, kind, meta) => { events.push({ kind, meta }); },
    },
  });
  const gateway = createRuntimeLinkGateway({ db, config: config(env), broker, log: (event, fields) => { logs.push({ event, fields }); } });
  const ws = {
    data: {
      credential: { kind: "link", identity: { runtimeId: "rt", organizationId: "org", tokenHash: "hash", expiresAt: null } },
      peer: { ip: "203.0.113.7", agent: "http-agent" }, state: "awaiting_hello", connection: null, helloTimer: null,
    } as LinkSocketData,
    send: (data: string | Uint8Array) => { if (typeof data === "string") frames.push(decodeTextFrame(data)); return 1; },
    close: (code = 1000) => { closed.push(code); },
  };
  try {
    gateway.websocket.message(ws, JSON.stringify({ t: "hello", protocol: 1, ...(agent === undefined ? {} : { agent }) }));
    for (let attempt = 0; attempt < 100 && !frames.some((frame) => frame.t === "link.context") && !closed.length; attempt++) await Bun.sleep(1);
    expect(frames.some((frame) => frame.t === "link.context")).toBe(true);
    return { statements, events, logs, frames, closed, bound: broker.connected("rt"), tx };
  } finally {
    broker.closeAll();
  }
}

describe("déclaration hello et migration", () => {
  test("un agent obsolète reste admis, est persisté sous son bail et journalisé avec le minimum", async () => {
    const session = await hello("hermes-setup/v0.1.0", { RUNTIME_CONNECTOR_MIN_VERSION: "v0.2.0", RUNTIME_CONNECTOR_LATEST_VERSION: "v0.3.0" });
    expect(session.bound).toBe(true);
    expect(session.closed).not.toContain(4401);
    const write = session.statements.find(({ sql }) => sql.includes("set link_agent ="));
    expect(write?.sql).toContain("link_agent_seen_at = now()");
    expect(write?.sql).toContain("link_generation =");
    expect(write?.values).toEqual(["hermes-setup/v0.1.0", null, "rt", "org", "42", "hash", "hash"]);
    const meta = { ip: "203.0.113.7", agent: "hermes-setup/v0.1.0", minimum: "v0.2.0" };
    expect(session.events.filter(({ kind }) => kind === "agent_outdated")).toEqual([{ kind: "agent_outdated", meta: { ...meta, instanceId: "agent-version-test", generation: "42" } }]);
    expect(session.logs).toContainEqual({ event: "runtime_link.agent_outdated", fields: { runtimeId: "rt", ...meta } });
    await insertRuntimeLinkEvent(session.tx, "org", "rt", "agent_outdated", meta);
    expect(session.statements.at(-1)?.values.at(-1)).toEqual({ minimum: "v0.2.0" });
    expect(session.frames.find(({ t }) => t === "link.context")).toMatchObject(versions);
  });

  test("sans obsolescence, aucun événement agent_outdated ; sans seuils, ni latestVersion ni minimumVersion", async () => {
    for (const [agent, env] of [
      ["hermes-setup/v0.1.0", {}],
      ["hermes-setup/v0.2.0", { RUNTIME_CONNECTOR_MIN_VERSION: "v0.2.0" }],
      ["hermes-setup/v0.1.0-dirty", { RUNTIME_CONNECTOR_MIN_VERSION: "v0.2.0" }],
    ] as const) {
      const session = await hello(agent, env);
      expect(session.bound).toBe(true);
      expect(session.events.some(({ kind }) => kind === "agent_outdated")).toBe(false);
      expect(session.logs.some(({ event }) => event === "runtime_link.agent_outdated")).toBe(false);
      // Sans seuils : ni latestVersion ni minimumVersion ; seule la borne des features accompagne le palier et l'origine.
      if (!Object.keys(env).length) expect(session.frames.find(({ t }) => t === "link.context")).toEqual({ t: "link.context", environment: "dev", openedbot: config().publicUrl, limits: { features: RELAY_MAX_FEATURES }, accepts: ["inventory.changed"] });
    }
  });

  test("tronque l'agent à 256 et conserve la déclaration précédente si hello n'en porte pas", async () => {
    const session = await hello("x".repeat(300));
    expect(session.statements.find(({ sql }) => sql.includes("set link_agent ="))?.values[0]).toBe("x".repeat(256));
    const absent = await hello();
    expect(absent.statements.some(({ sql }) => sql.includes("set link_agent ="))).toBe(false);
  });

  test("une panne de persistance reste informative et laisse le lien admis", async () => {
    const session = await hello("hermes-setup/v0.1.0", {}, true);
    expect(session.bound).toBe(true);
    expect(session.logs.some(({ event }) => event === "runtime_link.agent_write_failed")).toBe(true);
  });

  test("0055 est transactionnelle, ajoute les colonnes nullables commentées et conserve les kinds de 0053", () => {
    const sql = readFileSync(new URL("../../../db/migrations/0055_runtime_link_agent.sql", import.meta.url), "utf8");
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0055_runtime_link_agent')");
    expect(sql).toContain("add column link_agent text null");
    expect(sql).toContain("add column link_agent_seen_at timestamptz null");
    for (const column of ["link_agent", "link_agent_seen_at"]) expect(sql).toContain(`comment on column runtimes.${column} is`);
    const previous = readFileSync(new URL("../../../db/migrations/0053_audit_worm.sql", import.meta.url), "utf8");
    const kinds = previous.match(/check \(kind in \(([\s\S]*?)\)\)/)![1]!.match(/'[^']+'/g)!;
    for (const kind of [...kinds, "'device_key_registered'", "'agent_outdated'"]) expect(sql).toContain(kind);
    expect(sql).not.toMatch(/drop table|disable row level security|grant .*public/i);
  });
});
