/**
 * Local Web Push stand-in. Accepts a POST (the encrypted Web Push request),
 * records it, and answers 201 or 410 on command. Never talks to FCM or Mozilla.
 *
 *   bun tests/fake-push/server.ts
 *   FAKE_PUSH_PORT=18791 FAKE_PUSH_CERT=… FAKE_PUSH_KEY=… bun tests/fake-push/server.ts
 */
import { readFileSync } from "node:fs";

export const FAKE_PUSH_HOST = "127.0.0.1";
export const FAKE_PUSH_PORT = Number(process.env.FAKE_PUSH_PORT ?? 18_791);

export type FakePushDelivery = {
  at: string;
  method: string;
  path: string;
  status: number;
};

export type FakePushOptions = {
  hostname?: string;
  port?: number;
  cert?: string;
  key?: string;
};

export type FakePushServer = {
  url: string;
  port: number;
  journal: () => FakePushDelivery[];
  setStatus: (status: 201 | 410) => void;
  reset: () => void;
  stop: () => void;
};

export function startFakePush(options: FakePushOptions = {}): FakePushServer {
  const hostname = options.hostname ?? FAKE_PUSH_HOST;
  const port = options.port ?? FAKE_PUSH_PORT;
  let nextStatus: 201 | 410 = 201;
  const deliveries: FakePushDelivery[] = [];

  const tls = options.cert && options.key ? { cert: options.cert, key: options.key } : undefined;
  const server = Bun.serve({
    hostname,
    port,
    tls,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, status: nextStatus, deliveries: deliveries.length });
      }
      if (request.method === "GET" && url.pathname === "/journal") {
        return Response.json({ deliveries });
      }
      if (request.method === "POST" && url.pathname === "/reset") {
        deliveries.length = 0;
        nextStatus = 201;
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname === "/control") {
        const body = await request.json().catch(() => null) as { status?: unknown } | null;
        if (body?.status === 201 || body?.status === 410) {
          nextStatus = body.status;
          return Response.json({ status: nextStatus });
        }
        return Response.json({ error: "status must be 201 or 410" }, { status: 400 });
      }
      if (request.method === "POST") {
        const status = nextStatus;
        deliveries.push({
          at: new Date().toISOString(),
          method: request.method,
          path: url.pathname,
          status,
        });
        return new Response(status === 201 ? "Created" : "Gone", { status });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const scheme = tls ? "https" : "http";
  const boundPort = server.port;
  if (boundPort === undefined) throw new Error("fake push server did not bind a TCP port");
  return {
    url: `${scheme}://${hostname}:${boundPort}`,
    port: boundPort,
    journal: () => [...deliveries],
    setStatus: (status) => { nextStatus = status; },
    reset: () => { deliveries.length = 0; nextStatus = 201; },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const certPath = process.env.FAKE_PUSH_CERT;
  const keyPath = process.env.FAKE_PUSH_KEY;
  const server = startFakePush({
    cert: certPath ? readFileSync(certPath, "utf8") : undefined,
    key: keyPath ? readFileSync(keyPath, "utf8") : undefined,
  });
  console.log(JSON.stringify({ event: "fake-push.listen", url: server.url }));
}
