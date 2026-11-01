import { afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  RELAY_CLOSE_PROBE_FAILED,
  type RelayTextFrame,
} from "@openedbot/contracts-connector";
import { readApiConfig } from "../src/infrastructure/config";
import { hashCredential } from "../src/infrastructure/crypto";
import { RuntimeLinkBroker, type LinkLivenessStore } from "@openedbot/runtime-link/application/broker";
import {
  createRuntimeLinkGateway,
  RUNTIME_LINK_SUBPROTOCOL,
  RUNTIME_LINK_WS_PATH,
  type LinkSocketData,
} from "../src/routes/runtimes/runtime-link-routes";

/**
 * L'enrôlement par le lien, de bout en bout dans le processus : montée avec
 * ticket, `hello`, sonde à travers le tuyau, transaction unique, `link.issued`
 * après commit, et jamais le jeton dans autre chose que cette trame.
 */

const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const config = readApiConfig({ OHB_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: encryptionKey });

const TICKET_SECRET = "connector-ticket-secret";
const ENROLLMENT_ID = "7a0f8a3a-1111-4222-8333-444455556666";

type Statement = { sql: string; values: unknown[] };

type Fixture = {
  db: SQL;
  statements: Statement[];
  beginCount: () => number;
};

/** Une base factice qui journalise chaque requête, transaction par transaction. */
function fixtureDb(): Fixture {
  const statements: Statement[] = [];
  let begins = 0;
  let credentialHash = "";
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    statements.push({ sql, values });
    if (sql.includes("set_config('app.session_credential_hash'")) {
      credentialHash = String(values[0] ?? "");
      return [];
    }
    if (sql.includes("from runtime_enrollments") && sql.includes("secret_hash =")) {
      if (credentialHash !== hashCredential(TICKET_SECRET)) return [];
      return [{
        id: ENROLLMENT_ID,
        reachability: "connector",
        endpoint: null,
        runtimeName: "Runtime du lab",
        verificationCode: "ABC234",
        organizationId: "org-1",
        claimedAt: new Date(),
        consumedAt: null,
        runtimeId: null,
        expiresAt: new Date(Date.now() + 60_000),
      }];
    }
    if (sql.includes("from runtimes") && sql.includes("order by is_active desc")) return [];
    if (sql.includes("update runtime_enrollments") && sql.includes("consumed_at = now()")) {
      return [{ id: ENROLLMENT_ID }];
    }
    return [];
  }) as unknown as Bun.TransactionSQL;
  const db = {
    begin: async (callback: (tx: Bun.TransactionSQL) => Promise<unknown>) => {
      begins += 1;
      return callback(tx);
    },
  } as unknown as SQL;
  return { db, statements, beginCount: () => begins };
}

const silentLiveness: LinkLivenessStore = {
  connected: async () => {},
  seen: async () => {},
  disconnected: async () => {},
};

const servers: Array<{ stop(closeActive?: boolean): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

type HostSession = {
  frames: RelayTextFrame[];
  waitFrame(predicate: (frame: RelayTextFrame) => boolean, timeoutMs?: number): Promise<RelayTextFrame>;
  waitClose(timeoutMs?: number): Promise<number>;
  send(frame: RelayTextFrame): void;
  sendBody(id: number, body: string): void;
  logs: string[];
  fixture: Fixture;
  broker: RuntimeLinkBroker;
};

async function openEnrollmentSession(): Promise<HostSession> {
  const fixture = fixtureDb();
  const logs: string[] = [];
  const broker = new RuntimeLinkBroker({
    instanceId: "api-test",
    liveness: silentLiveness,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  });
  const gateway = createRuntimeLinkGateway({
    db: fixture.db,
    config,
    broker,
    probeTimeoutMs: 5_000,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  });
  const server = Bun.serve<LinkSocketData, string>({
    port: 0,
    fetch: (request, bunServer) => gateway.handleUpgrade(request, bunServer),
    websocket: {
      open: (ws) => gateway.websocket.open(ws),
      message: (ws, message) => gateway.websocket.message(ws, message),
      close: (ws, code, reason) => gateway.websocket.close(ws, code, reason),
      pong: (ws) => gateway.websocket.pong(ws),
    },
  });
  servers.push(server);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${RUNTIME_LINK_WS_PATH}`, {
    headers: { Authorization: `Bearer enrollment:${ENROLLMENT_ID}.${TICKET_SECRET}` },
    protocols: [RUNTIME_LINK_SUBPROTOCOL],
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const frames: RelayTextFrame[] = [];
  const waiters: Array<() => void> = [];
  let closedCode: number | null = null;
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") frames.push(decodeTextFrame(event.data));
    for (const wake of waiters.splice(0)) wake();
  });
  ws.addEventListener("close", (event) => {
    closedCode = event.code;
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
  });
  const waitFor = async <T>(read: () => T | null, timeoutMs: number, label: string): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const value = read();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  };
  ws.send(encodeTextFrame({ t: "hello", protocol: 1, agent: "edge-setup/test" }));
  return {
    frames,
    waitFrame: (predicate, timeoutMs = 3_000) => waitFor(() => frames.find(predicate) ?? null, timeoutMs, "frame"),
    waitClose: (timeoutMs = 3_000) => waitFor(() => closedCode, timeoutMs, "close"),
    send: (frame) => ws.send(encodeTextFrame(frame)),
    sendBody: (id, body) => {
      ws.send(encodeBinaryFrame(id, new TextEncoder().encode(body)));
    },
    logs,
    fixture,
    broker,
  };
}

function answerJson(session: HostSession, id: number, body: unknown, status = 200): void {
  session.send({ t: "res", id, status, headers: { "content-type": "application/json" } });
  session.sendBody(id, JSON.stringify(body));
  session.send({ t: "end", id });
}

/** L'hôte de test répond à la sonde comme un vrai gateway conforme au contrat. */
async function serveProbe(session: HostSession, options: { failHealth?: boolean } = {}): Promise<void> {
  const served = new Set<number>();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const request = session.frames.find(
      (frame): frame is RelayTextFrame & { t: "req" } => frame.t === "req" && !served.has(frame.id),
    );
    if (!request) {
      if (served.size >= 3) return;
      await Bun.sleep(10);
      continue;
    }
    served.add(request.id);
    const path = request.path.split("?")[0] ?? "";
    if (path === "/health") {
      if (options.failHealth) answerJson(session, request.id, { error: "boom" }, 500);
      else answerJson(session, request.id, { ok: true });
    } else if (path === "/v1/capabilities") {
      answerJson(session, request.id, { features: { max_concurrent_runs: 3, event_replay: true } });
    } else if (path === "/v1/toolsets") {
      answerJson(session, request.id, {
        data: [
          { name: "web", label: "Web", enabled: true, configured: true, tools: ["web_search"] },
          { name: "delegation", label: "Delegation", enabled: false, configured: false, tools: ["delegate_task"] },
        ],
      });
    } else {
      answerJson(session, request.id, { error: "unexpected" }, 404);
    }
  }
}

describe("enrôlement par le lien connecteur", () => {
  test("sonde réussie : une transaction, ticket brûlé, link.issued après commit", async () => {
    const session = await openEnrollmentSession();
    await serveProbe(session);
    const issued = await session.waitFrame((frame) => frame.t === "link.issued");
    if (issued.t !== "link.issued") throw new Error("unreachable");
    expect(issued.runtimeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued.linkToken.length).toBeGreaterThanOrEqual(32);

    const statements = session.fixture.statements;
    const insert = statements.find((entry) => entry.sql.includes("insert into runtimes"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("'connector'");
    expect(insert!.sql).toContain("link_token_hash");
    const burn = statements.find((entry) => entry.sql.includes("update runtime_enrollments") && entry.sql.includes("consumed_at = now()"));
    expect(burn).toBeDefined();
    const organization = statements.find((entry) => entry.sql.includes("update organizations") && entry.sql.includes("runtime_mode = 'external'"));
    expect(organization).toBeDefined();
    // Les valeurs liées portent le HASH du jeton, jamais le jeton.
    expect(insert!.values).toContain(hashCredential(issued.linkToken));
    const everything = JSON.stringify(statements) + session.logs.join("\n");
    expect(everything).not.toContain(issued.linkToken);
    // La connexion est désormais liée : le broker sert ce runtime.
    expect(session.broker.connected(issued.runtimeId)).toBe(true);
  });

  test("sonde en échec : err puis fermeture 4003, aucune ligne écrite, ticket réutilisable", async () => {
    const session = await openEnrollmentSession();
    void serveProbe(session, { failHealth: true });
    const code = await session.waitClose();
    expect(code).toBe(RELAY_CLOSE_PROBE_FAILED);
    expect(session.frames.some((frame) => frame.t === "err")).toBe(true);
    const statements = session.fixture.statements;
    expect(statements.some((entry) => entry.sql.includes("insert into runtimes"))).toBe(false);
    expect(statements.some((entry) => entry.sql.includes("consumed_at = now()") && entry.sql.includes("update"))).toBe(false);
  });

  test("le jeton de lien n'apparaît dans aucune réponse HTTP", async () => {
    // Les seules réponses HTTP du flux sont celles de la montée : un upgrade
    // (101, sans corps) ou un refus. On rejoue un refus et on prouve que même
    // lui ne peut pas transporter un jeton : il est produit AVANT toute
    // émission de jeton, et le succès ne rend aucun corps du tout.
    const fixture = fixtureDb();
    const broker = new RuntimeLinkBroker({ instanceId: "api-test", liveness: silentLiveness, log: () => {} });
    const gateway = createRuntimeLinkGateway({ db: fixture.db, config, broker, log: () => {} });
    const refused = await gateway.handleUpgrade(
      new Request(`http://api.test${RUNTIME_LINK_WS_PATH}`, {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer enrollment:${ENROLLMENT_ID}.wrong-secret`,
        },
      }),
      { upgrade: () => true },
    );
    expect(refused?.status).toBe(401);
    const body = await refused!.text();
    expect(body).not.toMatch(/linkToken|link_token/);
  });
});
