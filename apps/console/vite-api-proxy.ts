import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProxyOptions } from "vite";

/** A pipe forwards EOF, but does not close its destination on a source abort.
 * Vite's unlimited SSE proxy otherwise keeps the browser waiting after an API
 * restart, so its existing reconnect loop never receives EOF or an error.
 */
export function closeSseOnUpstreamLoss(upstream: IncomingMessage, downstream: ServerResponse): void {
  if (!String(upstream.headers["content-type"] ?? "").toLowerCase().startsWith("text/event-stream")) return;
  const abort = () => {
    if (!downstream.destroyed && !downstream.writableEnded) downstream.destroy();
  };
  const readerClosed = () => {
    if (!downstream.writableEnded) upstream.destroy();
  };
  upstream.once("aborted", abort);
  upstream.once("error", abort);
  upstream.once("close", () => {
    if (!upstream.complete) abort();
    upstream.off("aborted", abort);
    upstream.off("error", abort);
    downstream.off("close", readerClosed);
  });
  downstream.once("close", readerClosed);
}

export const configureSseProxy: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("proxyRes", (upstream, _request, downstream) => closeSseOnUpstreamLoss(upstream, downstream));
};
