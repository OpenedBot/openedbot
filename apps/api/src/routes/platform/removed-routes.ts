import { Hono } from "hono";

/**
 * API roots that no longer exist, answered 404 BEFORE the session check: a
 * client still calling one reads "route not found", not "authentication
 * required", whatever its cookies. `/api/staff` is the backoffice's former
 * root; it lives under `/api/pro/staff` (staff plug-in) since step 6.
 */
export const REMOVED_API_ROOTS: readonly string[] = ["/api/staff"];

export function removedApiRoutes(): Hono {
  const app = new Hono();
  for (const root of REMOVED_API_ROOTS) {
    app.all(root, (context) => context.notFound());
    app.all(`${root}/*`, (context) => context.notFound());
  }
  return app;
}
