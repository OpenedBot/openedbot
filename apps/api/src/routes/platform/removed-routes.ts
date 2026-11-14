import { Hono } from "hono";

/**
 * API roots that no longer exist, answered 404 BEFORE the session check: a
 * client still calling one reads "route not found", not "authentication
 * required", whatever its cookies.
 * `/api/waitlist` was the public waitlist signup, removed with the waitlist
 * (plan 0005): signup is open. `/api/support` was the help desk, served by a
 * plug-in only and removed from the open core with its console screens.
 */
export const REMOVED_API_ROOTS: readonly string[] = ["/api/waitlist", "/api/support"];

export function removedApiRoutes(): Hono {
  const app = new Hono();
  for (const root of REMOVED_API_ROOTS) {
    app.all(root, (context) => context.notFound());
    app.all(`${root}/*`, (context) => context.notFound());
  }
  return app;
}
