import type { SQL } from "bun";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  type RelayTextFrame,
} from "@openedbot/contracts-connector";
import { readApiConfig, type ApiConfig } from "../../src/infrastructure/config";
import { hashCredential } from "../../src/infrastructure/crypto";
import {
  RuntimeLinkBroker,
  type LinkDispatchRecord,
  type LinkEventKind,
  type LinkEventMeta,
  type LinkLivenessStore,
} from "@openedbot/runtime-link/application/broker";
import type { AnchorWrite } from "@openedbot/runtime-link/application/audit-keys";
import { linkPopMessage } from "@openedbot/runtime-link/application/link-pop";
import {
  createRuntimeLinkGateway,
  RUNTIME_LINK_SUBPROTOCOL,
  RUNTIME_LINK_WS_PATH,
  type LinkSocketData,
  type RuntimeLinkGatewayDependencies,
} from "../../src/routes/runtimes/runtime-link-routes";

/**
 * A link session by TOKEN (not by ticket), end to end in the
 * process: bring-up `Bearer link:<runtimeId>.<token>`, `hello`, then: depending on
 * what the runtime has in the database: proof-of-possession challenge, binding, `audit.key`.
 * The database is fake and journals every query; liveness is
 * recorded; frames and closes are observable.
 */
export const LINK_RUNTIME_ID = "8f3b2c1d-1111-4222-8333-444455556666";
export const LINK_ORGANIZATION_ID = "org-1";
export const LINK_TOKEN = "link-token-secret";
export const LINK_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

export type DeviceKey = { publicKey: string; privateKey: KeyObject };

/** An Ed25519 pair as `edge-setup link` generates one: raw public key in base64. */
export function deviceKey(): DeviceKey {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { publicKey: spki.subarray(spki.byteLength - 32).toString("base64"), privateKey: pair.privateKey };
}

/** What the host sends back to `link.challenge`: the signature of the possession message. */
export function proveLink(key: DeviceKey, nonce: string, wsUrl: string, runtimeId = LINK_RUNTIME_ID): string {
  return sign(null, linkPopMessage(nonce, runtimeId, wsUrl), key.privateKey).toString("base64");
}

export type Statement = { sql: string; values: unknown[] };
export type LivenessRecord =
  | { write: "connected" | "seen" | "disconnected"; runtimeId: string }
  | { write: "event"; runtimeId: string; kind: LinkEventKind; meta: LinkEventMeta }
  | { write: "anchor"; runtimeId: string; frame: unknown }
  | { write: "dispatched"; runtimeId: string; record: LinkDispatchRecord }
  | { write: "emergency_rotate"; runtimeId: string; meta: LinkEventMeta };

export type SessionOptions = {
  /** `runtimes.link_device_pubkey` as the database returns it; `null` = no key registered. */
  registeredDeviceKey?: string | null;
  /** The public key announced in `hello.devicePublicKey`. */
  offeredDeviceKey?: string | null;
  features?: string[];
  /** The presented token is the PREVIOUS one, still in grace (rotation in progress). */
  previousToken?: boolean;
  /** The process's `RUNTIME_LINK_REQUIRE_POP`. */
  requirePop?: boolean;
  popTimeoutMs?: number;
  wsUrls?: string[];
  /** Address announced by `X-Forwarded-For` (the configuration trusts the proxy). */
  forwardedFor?: string;
  anchorOutcome?: AnchorWrite;
  /** Audit keys already in the database for this runtime (encrypted rows). */
  auditKeyRows?: Array<Record<string, unknown>>;
  /** The runtime's organization and its owner, as `link.context` reads them; `null` = organization without an owner. */
  organizationOwner?: { email: string; displayName: string | null } | null;
  /** A broker and a database shared between two sessions (replacement, emergency rotation). */
  shared?: SharedFixture;
  config?: ApiConfig;
  /** Latency of each query, like a real database: without it, every `await` resolves before the next frame. */
  dbLatencyMs?: number;
};

export type SharedFixture = {
  broker: RuntimeLinkBroker;
  liveness: LivenessRecord[];
  statements: Statement[];
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  server: { port: number | undefined; stop(closeActive?: boolean): void };
  gateway: ReturnType<typeof createRuntimeLinkGateway>;
  config: ApiConfig;
};

export type LinkSession = {
  frames: RelayTextFrame[];
  waitFrame(predicate: (frame: RelayTextFrame) => boolean, timeoutMs?: number): Promise<RelayTextFrame>;
  waitClose(timeoutMs?: number): Promise<number>;
  waitLiveness(predicate: (entry: LivenessRecord) => boolean, timeoutMs?: number): Promise<LivenessRecord>;
  send(frame: RelayTextFrame): void;
  sendBody(id: number, body: string): void;
  sendRaw(text: string): void;
  wsUrl: string;
  shared: SharedFixture;
};

const servers: Array<{ stop(closeActive?: boolean): void }> = [];
export function stopLinkSessions(): void {
  for (const server of servers.splice(0)) server.stop(true);
}

export function linkConfig(overrides: Record<string, string> = {}): ApiConfig {
  return readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: LINK_ENCRYPTION_KEY, API_TRUST_PROXY: "1", ...overrides });
}

function fixtureDb(options: SessionOptions, statements: Statement[]): SQL {
  let credentialHash = "";
  const tokenHash = hashCredential(LINK_TOKEN);
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    statements.push({ sql, values });
    if (options.dbLatencyMs) await Bun.sleep(options.dbLatencyMs);
    if (sql.includes("set_config('app.session_credential_hash'")) {
      credentialHash = String(values[0] ?? "");
      return [];
    }
    if (sql.includes("from runtimes") && sql.includes("link_device_pubkey as \"deviceKey\"")) {
      if (credentialHash !== tokenHash) return [];
      return [{
        id: LINK_RUNTIME_ID,
        organizationId: LINK_ORGANIZATION_ID,
        isCurrent: !options.previousToken,
        previousExpiresAt: options.previousToken ? new Date(Date.now() + 5 * 60_000) : null,
        deviceKey: options.registeredDeviceKey ?? null,
      }];
    }
    if (sql.includes("from runtime_audit_keys")) return options.auditKeyRows ?? [];
    if (sql.includes("from organizations o")) {
      const owner = options.organizationOwner === undefined ? { email: "owner@example.com", displayName: "Owner" } : options.organizationOwner;
      return [{ id: LINK_ORGANIZATION_ID, name: "Acme", slug: "acme", email: owner?.email ?? null, displayName: owner?.displayName ?? null }];
    }
    if (sql.includes("insert into runtime_audit_keys")) return [];
    // The device-key UPDATE returns the touched row: the current token still exists.
    if (sql.includes("update runtimes set link_device_pubkey =")) return credentialHash === tokenHash ? [{ id: LINK_RUNTIME_ID }] : [];
    return [];
  }) as unknown as Bun.TransactionSQL;
  return {
    begin: async (callback: (inner: Bun.TransactionSQL) => Promise<unknown>) => callback(tx),
  } as unknown as SQL;
}

function recordingLiveness(records: LivenessRecord[], options: SessionOptions): LinkLivenessStore {
  return {
    async connected(link) { records.push({ write: "connected", runtimeId: link.runtimeId }); },
    async seen(link) { records.push({ write: "seen", runtimeId: link.runtimeId }); },
    async disconnected(link) { records.push({ write: "disconnected", runtimeId: link.runtimeId }); },
    async event(link, kind, meta) { records.push({ write: "event", runtimeId: link.runtimeId, kind, meta }); },
    async auditAnchor(link, frame) {
      records.push({ write: "anchor", runtimeId: link.runtimeId, frame });
      return options.anchorOutcome ?? "recorded";
    },
    async dispatched(link, record) { records.push({ write: "dispatched", runtimeId: link.runtimeId, record }); },
    async emergencyRotate(link, meta) { records.push({ write: "emergency_rotate", runtimeId: link.runtimeId, meta }); },
  };
}

export function startShared(options: SessionOptions = {}): SharedFixture {
  const statements: Statement[] = [];
  const liveness: LivenessRecord[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const config = options.config ?? linkConfig(options.requirePop ? { RUNTIME_LINK_REQUIRE_POP: "1" } : {});
  const broker = new RuntimeLinkBroker({
    instanceId: "api-test",
    liveness: recordingLiveness(liveness, options),
    pingIntervalMs: 60_000,
    log: (event, fields) => logs.push({ event, fields }),
  });
  // The URL the host signs is the ephemeral server's: known after
  // startup, it is pushed into the array the gateway consults.
  const wsUrls: string[] = options.wsUrls ? [...options.wsUrls] : [];
  const deps: RuntimeLinkGatewayDependencies = {
    db: fixtureDb(options, statements),
    config,
    broker,
    popTimeoutMs: options.popTimeoutMs ?? 2_000,
    wsUrls,
    log: (event, fields) => logs.push({ event, fields }),
  };
  const gateway = createRuntimeLinkGateway(deps);
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
  if (!options.wsUrls) wsUrls.push(`ws://127.0.0.1:${server.port}${RUNTIME_LINK_WS_PATH}`);
  return { broker, liveness, statements, logs, server, gateway, config };
}

export async function openLinkSession(options: SessionOptions = {}): Promise<LinkSession> {
  const shared = options.shared ?? startShared(options);
  const wsUrl = `ws://127.0.0.1:${shared.server.port}${RUNTIME_LINK_WS_PATH}`;
  const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer link:${LINK_RUNTIME_ID}.${LINK_TOKEN}`,
      ...(options.forwardedFor ? { "X-Forwarded-For": options.forwardedFor } : {}),
    },
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
  ws.send(encodeTextFrame({
    t: "hello",
    protocol: 1,
    agent: "edge-setup/test",
    ...(options.features ? { features: options.features } : {}),
    ...(options.offeredDeviceKey ? { devicePublicKey: options.offeredDeviceKey } : {}),
  }));
  return {
    frames,
    waitFrame: (predicate, timeoutMs = 3_000) => waitFor(() => frames.find(predicate) ?? null, timeoutMs, "frame"),
    waitClose: (timeoutMs = 3_000) => waitFor(() => closedCode, timeoutMs, "close"),
    waitLiveness: (predicate, timeoutMs = 3_000) => waitFor(() => shared.liveness.find(predicate) ?? null, timeoutMs, "liveness"),
    send: (frame) => ws.send(encodeTextFrame(frame)),
    sendBody: (id, body) => ws.send(encodeBinaryFrame(id, new TextEncoder().encode(body))),
    sendRaw: (text) => ws.send(text),
    wsUrl,
    shared,
  };
}
