import { isUuid } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";

export const EMPTY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

export function assertWorkspaceId(value: string): string {
  if (!isUuid(value)) throw new HttpError(400, "WORKSPACE_INVALID", "Espace invalide.");
  return value;
}

/**
 * Account endpoints never grant tenant access or escape a staff session.
 * A plug-in's own account action (accepting a fleet invitation, step 11.2)
 * is not listed here: the core does not know plug-in paths, the plug-in asks
 * for it through `host.fleet.session.authenticate`.
 */
export function isAccountIdentityPath(path: string): boolean {
  return /^\/api\/invite\/member\/[A-Za-z0-9_-]{32,128}\/(accept|decline)$/.test(path)
    || path === "/api/account/workspaces" || path === "/api/account/organizations"
    || path === "/api/auth/me"
    || path === "/api/auth/logout" || path === "/api/onboarding";
}

/**
 * An agency acting under a mandate never reaches the client's members,
 * billing (`/api/pro/billing`, served by the plug-in billing since step 8d;
 * `/api/billing` kept so an old path stays refused), exports or purges.
 */
export function agencyRequestAllowed(method: string, pathname: string, search: URLSearchParams): boolean {
  if (pathname.startsWith("/api/billing") || pathname.startsWith("/api/pro/billing") || pathname.startsWith("/api/organization")
    || pathname.startsWith("/api/account/deletion") || pathname.startsWith("/api/team-exports")
    || pathname.startsWith("/api/runtime/exposures")) return false;
  if (method === "DELETE" && /^\/api\/bots\/[^/]+\/?$/.test(pathname)
    && search.has("purge")) return false;
  return true;
}
