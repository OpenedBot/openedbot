// Isolated cross-language test fixture: production broker/protocol, no database,
// credentials or deployed runtime. Started and killed by the opt-in Go test.
import { decodeTextFrame } from "@openedbot/contracts-connector";
import { RuntimeLinkBroker, type LinkConnection } from "../../modules/runtime-link/src/application/broker";

const state = { sockets: 0, closes: 0, features: [] as string[], events: [] as string[], diagnostics: [] as Array<{ eventId: string; code: string; state: string; stack?: string }> };
const broker = new RuntimeLinkBroker({
  instanceId: "cross-language-e2e",
  pingIntervalMs: 100,
  firstResponseTimeoutMs: 5_000,
  log: () => {},
  liveness: {
    async connected(_link, _instance, features) { state.features = features; },
    async capabilities(_link, _instance, features) { state.features = features; },
    async seen() {},
    async disconnected() {},
    async event(_link, kind) { state.events.push(kind); },
    async diagnostic(_link, frame) {
      if (!state.diagnostics.some((event) => event.eventId === frame.eventId)) {
        state.diagnostics.push({ eventId: frame.eventId, code: frame.code, state: frame.state, stack: frame.stack });
      }
    },
  },
});
const server = Bun.serve<{ connection: LinkConnection | null }>({
  hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/state") return Response.json({ ...state, connected: broker.connected("fixture") });
    if (path === "/relay") return broker.dialer("fixture")({ method: "GET", path: "/health", headers: {}, body: null }, request.signal);
    if (path === "/ws" && server.upgrade(request, { data: { connection: null }, headers: { "Sec-WebSocket-Protocol": "hermes-connector.v1" } })) return;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) { state.sockets++; ws.data.connection = broker.open(ws); },
    message(ws, data) {
      const connection = ws.data.connection!;
      if (typeof data !== "string") { connection.handleBinary(new Uint8Array(data)); return; }
      const frame = decodeTextFrame(data);
      if (frame.t === "hello") {
        connection.features = frame.features ?? [];
        broker.bind(connection, { runtimeId: "fixture", organizationId: "fixture", tokenHash: "fixture", expiresAt: null });
      } else connection.handleText(frame);
    },
    close(ws, code, reason) { state.closes++; broker.release(ws.data.connection!, code, reason); },
  },
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
