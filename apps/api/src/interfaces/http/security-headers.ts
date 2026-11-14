import type { MiddlewareHandler } from "hono";

/**
 * The security headers of every `/api/*` response, whatever the name that
 * serves it: `openedbot.app/api` (the console), `api.openedbot.app` (native
 * clients) or any other name a tunnel sends to the API without going through
 * the reverse proxy. They therefore do not rely on the edge.
 *
 * Set only if they are missing: a route that has already decided keeps its
 * decision (the `sandbox` CSP of an HTML attachment, the cache of an image).
 *
 * - `nosniff`: a JSON body or an attachment is never reinterpreted
 *   as HTML or as a script by the browser.
 * - `default-src 'none'; frame-ancestors 'none'`: an API response
 *   opened as a document executes nothing and is framed nowhere.
 * - `Cross-Origin-Resource-Policy: same-site`: only pages of the same site
 *   (`*.openedbot.app`) can embed a response, images included; native
 *   clients, which are not pages, are not concerned.
 * - `Cache-Control: no-store`: an authenticated response stays in no
 *   shared cache nor on disk.
 */
export const API_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"],
  ["Cross-Origin-Resource-Policy", "same-site"],
  ["Cache-Control", "no-store"],
];

export function apiSecurityHeaders(): MiddlewareHandler {
  return async (context, next) => {
    await next();
    const missing = API_SECURITY_HEADERS.filter(([name]) => !context.res.headers.has(name));
    if (missing.length === 0) return;
    try {
      for (const [name, value] of missing) context.res.headers.set(name, value);
    } catch {
      // A response relayed as-is (fetch) has immutable headers:
      // copying it keeps the body streaming, status and headers included.
      context.res = new Response(context.res.body, context.res);
      for (const [name, value] of missing) context.res.headers.set(name, value);
    }
  };
}
