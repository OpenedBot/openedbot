import type { Context, MiddlewareHandler } from "hono";
import { createRateLimitGate, requestClientIp, type RateRule } from "@openedbot/platform-config/rate-limit";
import type { AppVariables } from "../../routes/identity/auth";

/**
 * La porte en mémoire, ses règles et la lecture de l'IP client vivent dans
 * `@openedbot/platform-config/rate-limit`, sans Hono : la passerelle du lien les
 * applique avant tout routeur. Ce fichier ne garde que le middleware Hono.
 */
export {
  API_RATE_RULES,
  AUTH_RATE_RULES,
  createRateLimitGate,
  requestClientIp,
  RUNTIME_LINK_UPGRADE_RULE,
  type RateLimitGate,
  type RateLimitVerdict,
  type RateRule,
} from "@openedbot/platform-config/rate-limit";

export type RateLimiterOptions = {
  /**
   * true UNIQUEMENT si l'API est réellement derrière un reverse-proxy de confiance
   * (nginx en prod, T14). Sinon l'IP est celle de la socket, car X-Forwarded-For
   * fourni par le client est falsifiable et rendrait la limite inopérante.
   */
  trustProxy?: boolean;
};

/**
 * Limiteur en mémoire (fenêtre fixe) par IP client et par route sensible.
 * Mono-instance aujourd'hui ; l'interface permettra un backend partagé (Redis/PG)
 * sans toucher aux appelants. Renvoie 429 + Retry-After au lieu de lever, afin de
 * préserver l'en-tête que app.onError effacerait.
 */
export function rateLimiter(
  rules: Record<string, RateRule>,
  options: RateLimiterOptions = {},
): MiddlewareHandler<{ Variables: AppVariables }> {
  const gate = createRateLimitGate(rules);

  return async (context, next) => {
    const verdict = gate.check(
      context.req.method,
      context.req.path,
      clientIp(context, options.trustProxy === true),
    );
    if (!verdict.limited) return next();
    context.header("Retry-After", String(verdict.retryAfterSeconds));
    return context.json(
      { error: { code: "RATE_LIMITED", message: "Trop de tentatives. Réessayez plus tard." } },
      429,
    );
  };
}

/**
 * IP de socket par défaut (non falsifiable). Derrière un proxy de confiance, on prend
 * le DERNIER hop de X-Forwarded-For : celui que le proxy appose (proxy_add_x_forwarded_for),
 * jamais le premier, qui peut être injecté par le client.
 */
function clientIp(context: Context, trustProxy: boolean): string {
  const server = context.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  return requestClientIp(context.req.raw, server, trustProxy);
}
