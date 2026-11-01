import { encodeBinaryFrame } from "@openedbot/contracts-connector";
import { RuntimeLinkBroker, type LinkConnection } from "../../src/application/broker";
import { withSafeCancel, withSseKeepalive } from "../../src/application/internal-relay";

// `sse` relays an event stream, `json` a plain body cut by the abort.
const mode = process.argv[2] === "json" ? "json" : "sse";

const broker = new RuntimeLinkBroker({ instanceId: "cancel-regression", liveness: { connected: async () => {}, seen: async () => {}, disconnected: async () => {} }, log: () => {} });
let connection: LinkConnection;
let cancellations = 0;
connection = broker.open({
  send(data) {
    if (typeof data === "string") {
      const frame = JSON.parse(data);
      if (frame.t === "req") queueMicrotask(() => {
        connection.handleText({ t: "res", id: frame.id, status: 200, headers: { "content-type": mode === "sse" ? "text/event-stream" : "application/json" } });
        connection.handleBinary(encodeBinaryFrame(frame.id, new TextEncoder().encode(mode === "sse" ? "data: first\n\n" : "{\"partial\":")));
      });
      if (frame.t === "cancel") cancellations++;
    }
    return 1;
  }, close() {},
});
await broker.bind(connection, { runtimeId: "runtime-1", organizationId: "org-1", tokenHash: "test", expiresAt: null });
const server = Bun.serve({ port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/health") return new Response("alive");
  const response = await broker.dialer("runtime-1")({ method: "GET", path: "/v1/runs/run-1/events", headers: {}, body: null }, request.signal);
  const body = mode === "sse" ? withSseKeepalive(response.body!, 500) : withSafeCancel(response.body!);
  return new Response(body, { headers: response.headers });
} });
try {
  for (let i = 0; i < 10; i++) {
    const abort = new AbortController();
    const response = await fetch(new URL("/events", server.url), { signal: abort.signal });
    const reader = response.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel().catch(() => {});
    await Bun.sleep(10);
  }
  await Bun.sleep(50);
  if (await (await fetch(new URL("/health", server.url))).text() !== "alive") throw new Error("gateway died");
  if (broker.inFlightCount !== 0 || cancellations !== 10) throw new Error(`unfinished cancellation: ${broker.inFlightCount}/${cancellations}`);
  console.info("gateway survived 10 consumer cancellations");
} finally {
  broker.closeAll();
  await server.stop(true);
}
