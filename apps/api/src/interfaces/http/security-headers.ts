import type { MiddlewareHandler } from "hono";

/**
 * Les en-têtes de sécurité de toute réponse `/api/*`, quel que soit le nom qui
 * la sert : `openedbot.app/api` (la console), `api.openedbot.app` (les clients
 * natifs) et l'origine du backoffice (`ADMIN_PUBLIC_URL`, `/api`), qu'un tunnel
 * envoie à l'API sans passer par le Caddy de Shuttle. Ils ne reposent donc pas sur le bord.
 *
 * Posés seulement s'ils manquent : une route qui a déjà décidé garde sa
 * décision (la CSP `sandbox` d'une pièce jointe HTML, le cache d'une image).
 *
 * - `nosniff` : un corps JSON ou une pièce jointe n'est jamais réinterprété
 *   en HTML ou en script par le navigateur.
 * - `default-src 'none'; frame-ancestors 'none'` : une réponse de l'API
 *   ouverte comme document n'exécute rien et ne s'encadre nulle part.
 * - `Cross-Origin-Resource-Policy: same-site` : seules les pages du même site
 *   (`*.openedbot.app`) peuvent intégrer une réponse, image comprise ; les
 *   clients natifs, qui ne sont pas des pages, ne sont pas concernés.
 * - `Cache-Control: no-store` : une réponse authentifiée ne reste dans aucun
 *   cache partagé ni sur disque.
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
      // Une réponse relayée telle quelle (fetch) a des en-têtes immuables :
      // la recopier garde le corps en flux, statut et en-têtes compris.
      context.res = new Response(context.res.body, context.res);
      for (const [name, value] of missing) context.res.headers.set(name, value);
    }
  };
}
