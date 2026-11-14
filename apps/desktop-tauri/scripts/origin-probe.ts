#!/usr/bin/env bun
/**
 * Measures the `Origin` header the desktop WebView really sends: a pass-through proxy in front of the local API that logs, for every
 * request, its method, path, `Origin` and the API's CORS answer. Point the
 * prototype at it (`OPENEDBOT_API_ORIGIN=http://127.0.0.1:8791`).
 *
 *   bun apps/desktop-tauri/scripts/origin-probe.ts [listen-port] [api-origin]
 *
 * Bodies stream through untouched (SSE included). Headers that carry a
 * credential (Authorization, Cookie) are never printed.
 */
const port = Number(process.argv[2] ?? 8791);
const upstream = (process.argv[3] ?? "http://127.0.0.1:8790").replace(/\/+$/, "");

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      duplex: "half",
    });
    // A refusal's code (never its whole body): `error.code` of the API's JSON errors.
    let errorCode: string | null = null;
    if (response.status >= 400 && response.headers.get("content-type")?.includes("application/json")) {
      const body = (await response.clone().json().catch(() => null)) as { error?: { code?: unknown } } | null;
      errorCode = typeof body?.error?.code === "string" ? body.error.code : null;
    }
    const line = {
      at: new Date().toISOString(),
      method: request.method,
      path: url.pathname,
      origin: request.headers.get("origin"),
      clientHeader: request.headers.get("x-openedbot-client"),
      bearer: request.headers.has("authorization"),
      cookie: request.headers.has("cookie"),
      status: response.status,
      errorCode,
      organization: request.headers.has("x-openedbot-organization"),
      allowOrigin: response.headers.get("access-control-allow-origin"),
      allowCredentials: response.headers.get("access-control-allow-credentials"),
      contentType: response.headers.get("content-type"),
    };
    console.log(JSON.stringify(line));
    // Bun's fetch has already decoded the body: its encoding and length no longer apply.
    const forwarded = new Headers(response.headers);
    forwarded.delete("content-encoding");
    forwarded.delete("content-length");
    return new Response(response.body, { status: response.status, headers: forwarded });
  },
});
console.log(`origin probe on http://127.0.0.1:${port} -> ${upstream}`);
