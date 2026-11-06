import type { MiddlewareHandler } from "hono";
import { REQUEST_ID_HEADER } from "@openedbot/platform-observability";

/** L'en-tête par lequel l'app de bureau annonce sa version (`client-version.ts`). */
export const CLIENT_HEADER = "X-OpenedBot-Client";

/** Ce qu'un préflight reste en cache dans le navigateur : sans lui, chaque appel `Bearer` en paie un. */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Le CORS de l'API.
 *
 *   - origines web (`browserOrigins`) : écho de l'origine, avec cookies
 *     (`Access-Control-Allow-Credentials`), comme toujours ;
 *   - origines de l'app de bureau (`nativeOrigins`) : écho de l'origine,
 *     **sans** cookies. La console embarquée parle en `Bearer` ; une session
 *     cookie ne doit jamais être utilisable depuis une origine locale ;
 *   - toute autre origine, y compris `null` : aucun en-tête CORS.
 *
 * `X-Request-Id` est exposé : la console l'affiche comme référence d'erreur,
 * et un appel cross-origin ne le lirait pas sans cela.
 */
export function corsMiddleware(
  origins: { browserOrigins: readonly string[]; nativeOrigins: readonly string[] },
  // Lu à chaque préflight : les alias de compatibilité s'installent après le montage.
  extraHeaders: () => readonly string[] = () => [],
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
        "Authorization", "Content-Type", "Idempotency-Key", "X-CSRF-Token", "X-OpenedBot-Organization", "X-OpenedBot-Fleet",
        ...extraHeaders(), "X-OpenedBot-Support-Token", "Last-Event-ID", CLIENT_HEADER,
      ].join(", "));
      context.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      if (web || native) context.header("Access-Control-Max-Age", String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
      return context.body(null, 204);
    }
    await next();
    // Une route qui rend une `Response` brute (le flux SSE `/api/events`) ne
    // reçoit pas les en-têtes posés par `context.header` avant elle : on les
    // repose sur la réponse finale. Sans eux, la console embarquée de l'app de
    // bureau (origine `tauri://localhost`) voyait son flux refusé par la
    // WebView et se reconnectait sans fin (ADR 0001, D2a).
    for (const [name, value] of allowed) {
      if (context.res.headers.get(name) !== value) context.res.headers.set(name, value);
    }
    // `Vary` se fusionne : la compression y a pu ajouter `Accept-Encoding`.
    if (web || native) withVaryOrigin(context.res.headers);
  };
}

function withVaryOrigin(headers: Headers): void {
  const current = headers.get("Vary");
  const values = (current ?? "").split(",").map((value) => value.trim().toLowerCase());
  if (values.includes("origin") || values.includes("*")) return;
  headers.set("Vary", current ? `${current}, Origin` : "Origin");
}
