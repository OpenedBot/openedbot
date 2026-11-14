import type { Context, MiddlewareHandler } from "hono";
import { createRateLimitGate, requestClientIp, type RateRule } from "@openedbot/platform-config/rate-limit";
import type { AppVariables } from "../../routes/identity/auth";

/**
 * The in-memory gate, its rules and the client-IP read live in
 * `@openedbot/platform-config/rate-limit`, without Hono: the link gateway
 * applies them before any router. This file keeps only the Hono middleware.
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
   * true ONLY if the API is actually behind a trusted reverse proxy
   * (nginx in prod, T14). Otherwise the IP is the socket's, because an X-Forwarded-For
   * supplied by the client is forgeable and would make the limit ineffective.
   */
  trustProxy?: boolean;
};

/**
 * In-memory limiter (fixed window) per client IP and per sensitive route.
 * Single-instance today; the interface will allow a shared backend (Redis/PG)
 * without touching callers. Returns 429 + Retry-After instead of throwing, so as to
 * preserve the header that app.onError would clear.
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
 * Socket IP by default (not forgeable). Behind a trusted proxy, take
 * the LAST hop of X-Forwarded-For: the one the proxy appends (proxy_add_x_forwarded_for),
 * never the first, which the client can inject.
 */
function clientIp(context: Context, trustProxy: boolean): string {
  const server = context.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  return requestClientIp(context.req.raw, server, trustProxy);
}
