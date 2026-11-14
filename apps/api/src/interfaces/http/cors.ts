import type { MiddlewareHandler } from "hono";
import { REQUEST_ID_HEADER } from "@openedbot/platform-observability";

/** The header by which the desktop app announces its version (`client-version.ts`). */
export const CLIENT_HEADER = "X-OpenedBot-Client";

/** How long a preflight stays cached in the browser: without it, every `Bearer` call pays for one. */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * The API's CORS.
 *
 *   - web origins (`browserOrigins`): echo of the origin, with cookies
 *     (`Access-Control-Allow-Credentials`), as always;
 *   - desktop-app origins (`nativeOrigins`): echo of the origin,
 *     **without** cookies. The embedded console speaks `Bearer`; a cookie
 *     session must never be usable from a local origin;
 *   - any other origin, including `null`: no CORS header.
 *
 * `X-Request-Id` is exposed: the console displays it as an error reference,
 * and a cross-origin call would not read it without that.
 */
export function corsMiddleware(
  origins: { browserOrigins: readonly string[]; nativeOrigins: readonly string[] },
): MiddlewareHandler {
  return async (context, next) => {
    const origin = context.req.header("Origin");
    const web = origin !== undefined && origins.browserOrigins.includes(origin);
    const native = !web && origin !== undefined && origins.nativeOrigins.includes(origin);
    const allowed: Array<[string, string]> = web || native
      ? [
          ["Access-Control-Allow-Origin", origin],
          ...(web ? [["Access-Control-Allow-Credentials", "true"] as [string, string]] : []),
          ["Access-Control-Expose-Headers", REQUEST_ID_HEADER],
        ]
      : [];
    for (const [name, value] of allowed) context.header(name, value);
    if (web || native) context.header("Vary", "Origin", { append: true });
    if (context.req.method === "OPTIONS") {
      context.header("Access-Control-Allow-Headers", [
        "Authorization", "Content-Type", "Idempotency-Key", "X-CSRF-Token", "X-OpenedBot-Organization",
        "Last-Event-ID", CLIENT_HEADER,
      ].join(", "));
      context.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      if (web || native) context.header("Access-Control-Max-Age", String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
      return context.body(null, 204);
    }
    await next();
    // A route that returns a raw `Response` (the SSE stream `/api/events`) does
    // not receive the headers set by `context.header` before it: they are
    // set again on the final response. Without them, the desktop app's embedded
    // console (origin `tauri://localhost`) saw its stream refused by the
    // WebView and reconnected endlessly.
    for (const [name, value] of allowed) {
      if (context.res.headers.get(name) !== value) context.res.headers.set(name, value);
    }
    // `Vary` is merged: compression may have added `Accept-Encoding` to it.
    if (web || native) withVaryOrigin(context.res.headers);
  };
}

function withVaryOrigin(headers: Headers): void {
  const current = headers.get("Vary");
  const values = (current ?? "").split(",").map((value) => value.trim().toLowerCase());
  if (values.includes("origin") || values.includes("*")) return;
  headers.set("Vary", current ? `${current}, Origin` : "Origin");
}
