import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SQL } from "bun";
import {
  encodeTextFrame,
  RELAY_CLOSE_REVOKED,
  RELAY_CLOSE_UNAUTHORIZED,
} from "@openedbot/contracts-connector";
import { readApiConfig } from "../src/infrastructure/config";
import { hashCredential } from "../src/infrastructure/crypto";
import { RuntimeLinkBroker, type LinkLivenessStore } from "@openedbot/runtime-link/application/broker";
import {
  createRuntimeLinkGateway,
  parseLinkAuthorization,
  RUNTIME_LINK_SUBPROTOCOL,
  RUNTIME_LINK_WS_PATH,
  type LinkSocketData,
} from "../src/routes/runtimes/runtime-link-routes";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const config = readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: encryptionKey });

const LINK_TOKEN = "link-token-secret";
const PREVIOUS_LINK_TOKEN = "link-token-before-rotation";
const TICKET_SECRET = "ticket-secret";
const RUNTIME_ID = "5f0f8a3a-1111-4222-8333-444455556666";
const ENROLLMENT_ID = "7a0f8a3a-1111-4222-8333-444455556666";

type EnrollmentFixture = {
  claimedAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
  reachability: "direct" | "connector";
};

/** The previous token after rotation (0027): accepted while its grace is running. */
type PreviousTokenFixture = { expiresAt: Date };

/**
 * Fake database: `withCredential` opens a transaction and the gate is the
 * presented hash: the fixture returns the row only when the hash matches,
 * as the RLS policy would.
 */
function fixtureDb(options: { enrollment?: EnrollmentFixture; previous?: PreviousTokenFixture; revoked?: boolean } = {}): SQL {
  const enrollment = options.enrollment ?? null;
  const previous = options.previous ?? null;
  let credentialHash = "";
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = [...strings].join(" ");
    if (statement.includes("set_config('app.session_credential_hash'")) {
      credentialHash = String(values[0] ?? "");
      return [];
    }
    if (statement.includes("from runtimes") && statement.includes("link_token_hash =")) {
      // `revoked_at is null`: a revoked row is never returned.
      if (options.revoked) return [];
      // The bring-up query accepts the current hash, or the previous one while
      // `link_token_previous_expires_at > now()`: the same predicate here.
      if (credentialHash === hashCredential(LINK_TOKEN)) {
        return [{ id: RUNTIME_ID, organizationId: "org-1", isCurrent: true, previousExpiresAt: previous?.expiresAt ?? null }];
      }
      if (
        previous
        && statement.includes("link_token_previous_hash =")
        && statement.includes("link_token_previous_expires_at > now()")
        && credentialHash === hashCredential(PREVIOUS_LINK_TOKEN)
        && previous.expiresAt.getTime() > Date.now()
      ) {
        return [{ id: RUNTIME_ID, organizationId: "org-1", isCurrent: false, previousExpiresAt: previous.expiresAt }];
      }
      return [];
    }
    if (statement.includes("from runtime_enrollments") && statement.includes("secret_hash =")) {
      if (!enrollment || credentialHash !== hashCredential(TICKET_SECRET)) return [];
      return [{
        id: ENROLLMENT_ID,
        reachability: enrollment.reachability,
        endpoint: enrollment.reachability === "direct" ? "https://hermes.example.test" : null,
        runtimeName: "Connector runtime",
        verificationCode: "ABC234",
        organizationId: enrollment.claimedAt ? "org-1" : null,
        claimedAt: enrollment.claimedAt,
        consumedAt: enrollment.consumedAt,
        runtimeId: null,
        expiresAt: enrollment.expiresAt,
      }];
    }
    return [];
  }) as unknown as Bun.TransactionSQL;
  return { begin: async (callback: (tx: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as SQL;
}

const silentLiveness: LinkLivenessStore = {
  connected: async () => {},
  seen: async () => {},
  disconnected: async () => {},
};

function gateway(db: SQL, liveness: LinkLivenessStore = silentLiveness) {
  const broker = new RuntimeLinkBroker({ instanceId: "api-test", liveness, log: () => {} });
  return { broker, gateway: createRuntimeLinkGateway({ db, config, broker, helloTimeoutMs: 200, log: () => {} }) };
}

function upgradeRequest(headers: Record<string, string>): Request {
  return new Request(`http://api.test${RUNTIME_LINK_WS_PATH}`, {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Protocol": RUNTIME_LINK_SUBPROTOCOL,
      ...headers,
    },
  });
}

type CapturedUpgrade = { data: LinkSocketData; headers?: Record<string, string> };

function stubServer(captured: CapturedUpgrade[] = []) {
  return {
    upgrade(_request: Request, options: { data: LinkSocketData; headers?: Record<string, string> }) {
      captured.push(options);
      return true;
    },
  };
}

async function errorCode(response: Response | undefined): Promise<string> {
  if (!response) throw new Error("expected an HTTP response, got an upgrade");
  const body = await response.json() as { error: { code: string } };
  return body.error.code;
}

describe("montée du lien : refus HTTP avant tout upgrade", () => {
  test("GET sans Upgrade répond 426, jamais un 404 Hono", async () => {
    const { gateway: g } = gateway(fixtureDb());
    const response = await g.handleUpgrade(new Request(`http://api.test${RUNTIME_LINK_WS_PATH}`), stubServer());
    expect(response?.status).toBe(426);
    expect(response?.headers.get("Upgrade")).toBe("websocket");
  });

  test("sans Authorization : 401", async () => {
    const { gateway: g } = gateway(fixtureDb());
    const response = await g.handleUpgrade(upgradeRequest({}), stubServer());
    expect(response?.status).toBe(401);
    expect(await errorCode(response)).toBe("LINK_AUTH_REQUIRED");
  });

  test("un jeton de lien inconnu ou décalé de son runtime : 401, sans fuite d'existence", async () => {
    const { gateway: g } = gateway(fixtureDb());
    const unknown = await g.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer link:${RUNTIME_ID}.wrong-token` }),
      stubServer(),
    );
    expect(unknown?.status).toBe(401);
    const mismatched = await g.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer link:99999999-9999-4999-8999-999999999999.${LINK_TOKEN}` }),
      stubServer(),
    );
    expect(mismatched?.status).toBe(401);
    expect(await errorCode(mismatched)).toBe("LINK_AUTH_INVALID");
  });

  test("un jeton de lien valide monte, identité liée au bon runtime", async () => {
    const { gateway: g } = gateway(fixtureDb());
    const captured: CapturedUpgrade[] = [];
    const response = await g.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer link:${RUNTIME_ID}.${LINK_TOKEN}` }),
      stubServer(captured),
    );
    expect(response).toBeUndefined();
    expect(captured).toHaveLength(1);
    const credential = captured[0]!.data.credential;
    expect(credential.kind).toBe("link");
    if (credential.kind === "link") {
      expect(credential.identity.runtimeId).toBe(RUNTIME_ID);
      expect(credential.identity.tokenHash).toBe(hashCredential(LINK_TOKEN));
    }
    expect(captured[0]!.headers?.["Sec-WebSocket-Protocol"]).toBe(RUNTIME_LINK_SUBPROTOCOL);
    expect(credential.kind === "link" && credential.identity.expiresAt).toBeNull();
  });

  // Rotation (0027): the host that has not yet received `link.rotate`
  // reconnects with the previous token for ten minutes; after that, nothing.
  test("l'ancien jeton monte pendant la grâce de rotation, et plus après", async () => {
    const inGrace = gateway(fixtureDb({ previous: { expiresAt: new Date(Date.now() + 60_000) } }));
    const captured: CapturedUpgrade[] = [];
    const accepted = await inGrace.gateway.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer link:${RUNTIME_ID}.${PREVIOUS_LINK_TOKEN}` }),
      stubServer(captured),
    );
    expect(accepted).toBeUndefined();
    const credential = captured[0]!.data.credential;
    expect(credential.kind === "link" && credential.identity.tokenHash).toBe(hashCredential(PREVIOUS_LINK_TOKEN));
    // The identity carries the end of grace: the broker will close 4401 at that instant.
    expect(credential.kind === "link" && credential.identity.expiresAt).toBeGreaterThan(Date.now());

    const expired = gateway(fixtureDb({ previous: { expiresAt: new Date(Date.now() - 1_000) } }));
    const refused = await expired.gateway.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer link:${RUNTIME_ID}.${PREVIOUS_LINK_TOKEN}` }),
      stubServer(),
    );
    expect(refused?.status).toBe(401);
    expect(await errorCode(refused)).toBe("LINK_AUTH_INVALID");
    // The current token, for its part, still connects.
    const current = await expired.gateway.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer link:${RUNTIME_ID}.${LINK_TOKEN}` }),
      stubServer(),
    );
    expect(current).toBeUndefined();
  });

  test("l'adresse et le User-Agent de la montée sont posés sur la socket, pour le journal du lien", async () => {
    const { gateway: g } = gateway(fixtureDb());
    const captured: CapturedUpgrade[] = [];
    await g.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer link:${RUNTIME_ID}.${LINK_TOKEN}`, "User-Agent": "hermes-setup/1.2.0" }),
      { ...stubServer(captured), requestIP: () => ({ address: "203.0.113.9" }) },
    );
    expect(captured[0]!.data.peer).toEqual({ ip: "203.0.113.9", agent: "hermes-setup/1.2.0" });
  });

  test("un ticket réclamé connector monte en provisoire", async () => {
    const { gateway: g } = gateway(fixtureDb({
      enrollment: { claimedAt: new Date(), consumedAt: null, expiresAt: new Date(Date.now() + 60_000), reachability: "connector" },
    }));
    const captured: CapturedUpgrade[] = [];
    const response = await g.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer enrollment:${ENROLLMENT_ID}.${TICKET_SECRET}` }),
      stubServer(captured),
    );
    expect(response).toBeUndefined();
    expect(captured[0]!.data.credential.kind).toBe("enrollment");
    expect(captured[0]!.data.state).toBe("awaiting_hello");
  });

  test("ticket expiré : 410 ; consommé : 409 ; non réclamé : 409 ; direct : 409", async () => {
    const cases: Array<{ enrollment: EnrollmentFixture; status: number; code: string }> = [
      {
        enrollment: { claimedAt: new Date(), consumedAt: null, expiresAt: new Date(Date.now() - 1_000), reachability: "connector" },
        status: 410,
        code: "ENROLLMENT_EXPIRED",
      },
      {
        enrollment: { claimedAt: new Date(), consumedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), reachability: "connector" },
        status: 409,
        code: "ENROLLMENT_CONSUMED",
      },
      {
        enrollment: { claimedAt: null, consumedAt: null, expiresAt: new Date(Date.now() + 60_000), reachability: "connector" },
        status: 409,
        code: "ENROLLMENT_UNCLAIMED",
      },
      {
        enrollment: { claimedAt: new Date(), consumedAt: null, expiresAt: new Date(Date.now() + 60_000), reachability: "direct" },
        status: 409,
        code: "ENROLLMENT_REACHABILITY_MISMATCH",
      },
    ];
    for (const entry of cases) {
      const { gateway: g } = gateway(fixtureDb({ enrollment: entry.enrollment }));
      const response = await g.handleUpgrade(
        upgradeRequest({ Authorization: `Bearer enrollment:${ENROLLMENT_ID}.${TICKET_SECRET}` }),
        stubServer(),
      );
      expect(response?.status).toBe(entry.status);
      expect(await errorCode(response)).toBe(entry.code);
    }
  });
});

describe("parseLinkAuthorization", () => {
  test("n'accepte que les deux schémas du contrat", () => {
    expect(parseLinkAuthorization(`Bearer link:${RUNTIME_ID}.token`)?.scheme).toBe("link");
    expect(parseLinkAuthorization(`Bearer enrollment:${ENROLLMENT_ID}.secret`)?.scheme).toBe("enrollment");
    expect(parseLinkAuthorization(`Bearer session:${RUNTIME_ID}.token`)).toBeNull();
    expect(parseLinkAuthorization("Bearer link:not-a-uuid.token")).toBeNull();
    expect(parseLinkAuthorization(`Bearer link:${RUNTIME_ID}.`)).toBeNull();
    expect(parseLinkAuthorization("Basic abc")).toBeNull();
    expect(parseLinkAuthorization(null)).toBeNull();
  });
});

const servers: Array<{ stop(closeActive?: boolean): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

async function connectedSocket(authorization: string): Promise<{ ws: WebSocket; closed: Promise<number>; broker: RuntimeLinkBroker }> {
  const { gateway: g, broker } = gateway(fixtureDb());
  const server = Bun.serve<LinkSocketData, string>({
    port: 0,
    fetch(request, bunServer) {
      return g.handleUpgrade(request, bunServer);
    },
    websocket: {
      open: (ws) => g.websocket.open(ws),
      message: (ws, message) => g.websocket.message(ws, message),
      close: (ws, code, reason) => g.websocket.close(ws, code, reason),
      pong: (ws) => g.websocket.pong(ws),
    },
  });
  servers.push(server);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}${RUNTIME_LINK_WS_PATH}`, {
    headers: { Authorization: authorization },
    protocols: [RUNTIME_LINK_SUBPROTOCOL],
  } as unknown as string[]);
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
  });
  return { ws, closed, broker };
}

describe("montée du lien : hello obligatoire", () => {
  test("toute première trame autre que hello ferme 4401", async () => {
    const { ws, closed } = await connectedSocket(`Bearer link:${RUNTIME_ID}.${LINK_TOKEN}`);
    ws.send(encodeTextFrame({ t: "ping" }));
    expect(await closed).toBe(RELAY_CLOSE_UNAUTHORIZED);
  });

  test("un silence prolongé avant hello ferme 4401", async () => {
    const { closed } = await connectedSocket(`Bearer link:${RUNTIME_ID}.${LINK_TOKEN}`);
    expect(await closed).toBe(RELAY_CLOSE_UNAUTHORIZED);
  });

  // `DELETE /api/runtime/:id` calls `links.revoke`: the open connection
  // closes 4004 at once, and the token opens nothing afterwards.
  test("un runtime révoqué voit sa connexion fermée 4004, et son jeton refusé à la montée suivante", async () => {
    const { ws, closed, broker } = await connectedSocket(`Bearer link:${RUNTIME_ID}.${LINK_TOKEN}`);
    ws.send(encodeTextFrame({ t: "hello", protocol: 1, agent: "edge-setup/test" }));
    const deadline = Date.now() + 2_000;
    while (!broker.connected(RUNTIME_ID) && Date.now() < deadline) await Bun.sleep(10);
    expect(broker.connected(RUNTIME_ID)).toBe(true);
    expect(broker.revoke(RUNTIME_ID)).toBe(true);
    expect(await closed).toBe(RELAY_CLOSE_REVOKED);
    expect(broker.connected(RUNTIME_ID)).toBe(false);
    // Revoked in the database (`revoked_at` set): the row is no longer returned, 401.
    const revoked = gateway(fixtureDb({ revoked: true }));
    const response = await revoked.gateway.handleUpgrade(
      upgradeRequest({ Authorization: `Bearer link:${RUNTIME_ID}.${LINK_TOKEN}` }),
      stubServer(),
    );
    expect(response?.status).toBe(401);
  });

  test("hello ouvre la session : le lien devient joignable", async () => {
    const { gateway: g, broker } = gateway(fixtureDb());
    const server = Bun.serve<LinkSocketData, string>({
      port: 0,
      fetch: (request, bunServer) => g.handleUpgrade(request, bunServer),
      websocket: {
        open: (ws) => g.websocket.open(ws),
        message: (ws, message) => g.websocket.message(ws, message),
        close: (ws, code, reason) => g.websocket.close(ws, code, reason),
        pong: (ws) => g.websocket.pong(ws),
      },
    });
    servers.push(server);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${RUNTIME_LINK_WS_PATH}`, {
      headers: { Authorization: `Bearer link:${RUNTIME_ID}.${LINK_TOKEN}` },
      protocols: [RUNTIME_LINK_SUBPROTOCOL],
    } as unknown as string[]);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
    ws.send(encodeTextFrame({ t: "hello", protocol: 1, agent: "edge-setup/test" }));
    const deadline = Date.now() + 2_000;
    while (!broker.connected(RUNTIME_ID) && Date.now() < deadline) await Bun.sleep(10);
    expect(broker.connected(RUNTIME_ID)).toBe(true);
    ws.close(1000, "bye");
  });

  // `hello.features` crosses the gateway through to the liveness write:
  // that is where `runtimes.link_features`, hence `management.kind`, comes from.
  test("les capacités de hello sont écrites telles quelles à la connexion", async () => {
    const written: Array<{ runtimeId: string; features: string[] }> = [];
    const liveness: LinkLivenessStore = {
      connected: async (link, _instanceId, features) => {
        written.push({ runtimeId: link.runtimeId, features });
      },
      seen: async () => {},
      disconnected: async () => {},
    };
    const { gateway: g, broker } = gateway(fixtureDb(), liveness);
    const server = Bun.serve<LinkSocketData, string>({
      port: 0,
      fetch: (request, bunServer) => g.handleUpgrade(request, bunServer),
      websocket: {
        open: (ws) => g.websocket.open(ws),
        message: (ws, message) => g.websocket.message(ws, message),
        close: (ws, code, reason) => g.websocket.close(ws, code, reason),
        pong: (ws) => g.websocket.pong(ws),
      },
    });
    servers.push(server);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${RUNTIME_LINK_WS_PATH}`, {
      headers: { Authorization: `Bearer link:${RUNTIME_ID}.${LINK_TOKEN}` },
      protocols: [RUNTIME_LINK_SUBPROTOCOL],
    } as unknown as string[]);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
    ws.send(encodeTextFrame({
      t: "hello",
      protocol: 1,
      agent: "hermes-setup/1.1.0",
      features: ["provider_management", "future_feature"],
    }));
    const deadline = Date.now() + 2_000;
    while (!broker.connected(RUNTIME_ID) && Date.now() < deadline) await Bun.sleep(10);
    expect(broker.connected(RUNTIME_ID)).toBe(true);
    expect(written).toEqual([{ runtimeId: RUNTIME_ID, features: ["provider_management", "future_feature"] }]);
    ws.close(1000, "bye");
  });
});

describe("le chemin du lien n'appartient pas à Hono", () => {
  const indexSource = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

  test("la montée est décidée dans Bun.serve.fetch, avant app.fetch", () => {
    const fetchGuard = indexSource.indexOf("RUNTIME_LINK_WS_PATH");
    const honoFallback = indexSource.indexOf("app.fetch(request");
    expect(fetchGuard).toBeGreaterThan(-1);
    expect(honoFallback).toBeGreaterThan(-1);
    expect(indexSource.indexOf("linkGateway.handleUpgrade")).toBeLessThan(honoFallback);
  });

  test("aucune route Hono n'est montée sur /api/runtime-links", () => {
    expect(indexSource).not.toContain('app.route("/api/runtime-links');
    expect(indexSource).not.toContain('app.get("/api/runtime-links');
    expect(indexSource).not.toContain('app.all("/api/runtime-links');
  });
});
