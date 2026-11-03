import { expect, test } from "bun:test";
import { fetch as nativeFetch } from "bun";
import { createServer, get, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { closeSseOnUpstreamLoss } from "../../vite-api-proxy";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// An ephemeral HTTP proxy, not a Vite dev server. It uses the same native
// IncomingMessage.pipe(ServerResponse) operation as Vite's bundled proxy.
for (const termination of ["abort", "end"] as const) {
  test(`SSE proxy promptly forwards upstream ${termination} to its reader`, async () => {
    let upstreamResponse!: ServerResponse;
    const upstream = createServer((_request, response) => {
      upstreamResponse = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
    });
    const upstreamUrl = await listen(upstream);
    const proxy = createServer((_request, response) => {
      const request = get(upstreamUrl, (incoming) => {
        response.writeHead(incoming.statusCode!, incoming.headers);
        closeSseOnUpstreamLoss(incoming, response);
        incoming.pipe(response);
      });
      request.on("error", () => response.destroy());
    });
    const proxyUrl = await listen(proxy);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // This transport test must not use the DOM preload's CORS-aware fetch, nor
      // hand it the preload's AbortController: Bun >= 1.4 rejects a foreign signal.
      const response = await nativeFetch(proxyUrl);
      reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
      const outcome = reader.read().then((value) => value.done ? "ended" : "data", () => "errored");
      if (termination === "abort") upstreamResponse.destroy();
      else upstreamResponse.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([outcome, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("hung"), 500); })]);
      clearTimeout(timer);
      expect(["ended", "errored"]).toContain(result);
      if (termination === "end") expect(result).toBe("ended");
    } finally {
      await reader?.cancel().catch(() => undefined);
      await close(proxy);
      await close(upstream);
    }
  });
}
