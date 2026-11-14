import { CONTROL_PROFILE_PREFIX } from "@openedbot/hermes";
import { RUNTIME_LINK_INTERNAL_PREFIX } from "@openedbot/runtime-link/application/instances";

/**
 * Reads a console or the worker repeats on a timer: one access-log line every
 * 5 s per open tab (`/api/runtime`) or every pass of a maintenance job (the
 * relay reads toward a host). Successful, they say nothing new.
 */
const POLLED_ROUTES = new Set([
  "/api/health",
  "/api/runtime",
  "/api/inbox",
  "/api/bots",
  "/api/runtimes/:runtimeId/provider-usage",
  `${RUNTIME_LINK_INTERNAL_PREFIX}/:runtimeId/proxy/*`,
]);

const CONTROL_PROBE = new RegExp(
  `^${RUNTIME_LINK_INTERNAL_PREFIX}/[^/]+/proxy/p/${CONTROL_PROFILE_PREFIX}[a-z0-9]+/health$`,
);

/**
 * `accessLogMiddleware({ isRoutine })`: logged at `debug` instead of
 * info/warn. A failed poll stays visible, and so does the control probe when
 * it does NOT answer 404 (a 200 there means the profiles are not isolated).
 */
export function isRoutineRequest(request: { method: string; route: string; path: string; status: number }): boolean {
  const read = request.method === "GET" || request.method === "HEAD";
  if (!read) return false;
  if (CONTROL_PROBE.test(request.path)) return request.status === 404;
  return request.status < 400 && POLLED_ROUTES.has(request.route);
}
