import {
  RUNTIME_LINK_WEBSOCKET_OPTIONS, RUNTIME_LINK_WS_PATH,
  type LinkSocketData, type RuntimeLinkGateway,
} from "./gateway";
import type { RuntimeLinkBroker } from "./broker";

/** Persistent transport listener, shared by the entry point and process-boundary tests. */
export function startRuntimeLinkServer(options: {
  gateway: RuntimeLinkGateway;
  broker: RuntimeLinkBroker;
  fetch: (request: Request) => Response | Promise<Response>;
  hostname?: string;
  port?: number;
  drainTimeoutMs?: number;
  onDraining?: () => Promise<void>;
  onStopped?: () => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}) {
  let draining = false;
  let stopping: Promise<void> | undefined;
  const timeout = options.drainTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error("Invalid gateway drain timeout");
  const server = Bun.serve<LinkSocketData>({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 8791,
    idleTimeout: 255,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(request, bunServer) {
      if (new URL(request.url).pathname === RUNTIME_LINK_WS_PATH) {
        if (draining) return Response.json({ error: { code: "LINK_DRAINING" } }, {
          status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" },
        });
        return options.gateway.handleUpgrade(request, {
          requestIP: (req) => bunServer.requestIP(req),
          upgrade: (req, settings) => !draining && bunServer.upgrade(req, settings),
        });
      }
      return options.fetch(request);
    },
    websocket: { ...RUNTIME_LINK_WEBSOCKET_OPTIONS, ...options.gateway.websocket },
  });
  return {
    server,
    get draining() { return draining; },
    drain(): Promise<void> {
      if (stopping) return stopping;
      draining = true;
      stopping = (async () => {
        const deadline = Date.now() + timeout;
        options.log?.("runtime_link.draining", { inFlight: options.broker.inFlightCount, timeout });
        // Heartbeats and owner routing are maintained by the caller until onStopped.
        if (options.onDraining) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(options.onDraining),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Drain observer deadline exceeded")), Math.max(0, deadline - Date.now()));
              }),
            ]);
          } catch {
            // An observer must never prevent the finite transport drain.
            options.log?.("runtime_link.drain_observer_failed", {});
          } finally {
            clearTimeout(timer);
          }
        }
        while ((options.broker.inFlightCount > 0 || server.pendingRequests > 0) && Date.now() < deadline) {
          await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
        }
        options.broker.closeAll(1001, "GATEWAY_SHUTDOWN");
        // Allow completed response bodies and the close frame to reach their peers.
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const stopped = server.stop(false);
          await Promise.race([
            stopped,
            new Promise<void>((resolve, reject) => {
              forceTimer = setTimeout(() => { void server.stop(true).then(resolve, reject); }, Math.max(0, deadline - Date.now()));
            }),
          ]);
        } finally {
          clearTimeout(forceTimer);
        }
        // Ownership metadata must settle after transport closure; propagate failure
        // rather than claiming a successful stop with DB work still unconfirmed.
        await options.onStopped?.();
        options.log?.("runtime_link.stopped", {});
      })();
      return stopping;
    },
  };
}
