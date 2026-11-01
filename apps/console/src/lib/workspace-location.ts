import { isUuid } from "@openedbot/contracts-primitives";
import type { AccountWorkspace } from "@openedbot/contracts-api";
import { findWorkspace } from "./workspace-directory";
import { isOwnFleet } from "./organization-gate";

/**
 * `/o/<slug>` (or a legacy `/o/<uuid>`). A client an agency operates lives under
 * that agency, `/o/<agency>/clients/<client>`. Older addresses are the pro
 * module's to map (`legacyHref`), never this one's. The slug shape mirrors
 * `organizations_slug_url_segment` (0085).
 */
const SLUG = "[a-z0-9][a-z0-9-]{0,62}";
const PREFIX = new RegExp(`^/o/(${SLUG})(?:/clients/(${SLUG}))?(?=/|$)`, "i");
const SEGMENT = new RegExp(`^${SLUG}$`, "i");
export const FLEET_OWN_SETTINGS_PATHS = [
  "/settings/team",
  "/settings/clients",
  "/settings/journal",
  "/settings/profile",
  "/settings/appearance",
  "/settings/notifications",
  "/settings/security",
] as const;
const FLEET_OWN_SETTINGS_SEGMENTS = FLEET_OWN_SETTINGS_PATHS
  .map((path) => path.slice("/settings/".length))
  .join("|");
const FLEET_ACCOUNT_PATH = new RegExp(
  `^/o/(${SLUG})/settings/(?:${FLEET_OWN_SETTINGS_SEGMENTS})/?$`,
  "i",
);

/**
 * Entry of the app when no workspace URL can be built: like `/`, the router
 * rewrites it to the overview (`public-landing-gate.ts`).
 */
export const APP_HOME_HREF = "/home";

/**
 * The fleet entry without an organization in the URL (`?fleet=`, `?choose=`):
 * it opens `/o/<fleet>/fleet`, or says there is no fleet.
 */
export const FLEET_ENTRY_PATH = "/fleets";

/** The workspace a URL designates: the client under an agency, the organization otherwise. */
export function workspaceInPath(path: string): string | null {
  const match = path.match(PREFIX);
  return match ? (match[2] ?? match[1] ?? null) : null;
}

/** The agency segment of `/o/<agency>/clients/<client>`, or `null` outside a client frame. */
export function fleetInPath(path: string): string | null {
  const match = path.match(PREFIX);
  return match?.[2] ? (match[1] ?? null) : null;
}

/**
 * The agency of `/o/<agency>/settings/...`, its own account pages
 * drawn in the agency frame (`agency-shell.tsx`), or `null`. The URL alone
 * cannot tell an agency from a personal organization: the tab's directory does.
 */
export function fleetAccountInPath(path: string): string | null {
  const match = path.match(FLEET_ACCOUNT_PATH);
  const workspace = match?.[1] ? findWorkspace(match[1]) : null;
  return workspace && isOwnFleet(workspace) ? match![1]! : null;
}

/** The organization UUID a URL segment designates, or `null` while its slug is unknown. */
export function resolveWorkspaceKey(key: string, userId?: string): string | null {
  return findWorkspace(key, userId)?.id ?? (isUuid(key) ? key : null);
}

/** The frame prefix of a public URL (`/o/<org>` or `/o/<agency>/clients/<client>`), `""` outside a workspace. */
export function workspaceFrameInPath(path: string): string {
  return path.match(PREFIX)?.[0] ?? "";
}

export function internalWorkspacePath(path: string): string {
  return path.replace(PREFIX, "") || "/";
}

/** Onboarding is an account-level flow, never a workspace URL. */
export function isOnboardingPath(path: string): boolean {
  return path === "/onboarding" || path.startsWith("/onboarding/");
}

export function isWorkspacePath(path: string): boolean {
  return path === "/" || /^\/(bot|g|inbox|settings|decisions|c|cs|fleet|summary|conversations)(\/|$)/.test(path);
}

function segmentOf(organizationId: string): string | null {
  const segment = findWorkspace(organizationId)?.slug ?? (isUuid(organizationId) ? organizationId : null);
  return segment && SEGMENT.test(segment) ? segment : null;
}

/**
 * An explicit agency must be granted by this client. Only a destination with
 * no selected agency may use the client's first granting agency.
 */
export function operatingFleetId(client: Pick<AccountWorkspace, "viaAgencyIds">, preferred?: string | null): string | null {
  const via = client.viaAgencyIds ?? [];
  const inPath = fleetInPath(globalThis.window?.location.pathname ?? "");
  if (preferred != null) return via.includes(preferred) ? preferred : null;
  if (inPath) {
    const selected = resolveWorkspaceKey(inPath);
    return selected && via.includes(selected) ? selected : null;
  }
  return via[0] ?? null;
}

/** Public URL of a workspace route: the slug, under its agency when the account operates it for a client. */
export function workspaceHref(organizationId: string, path = "/", fleetId?: string | null): string {
  if (!path.startsWith("/") || path.startsWith("//")) return APP_HOME_HREF;
  if (isOnboardingPath(path)) return path;
  const segment = segmentOf(organizationId);
  if (!segment) return APP_HOME_HREF;
  const known = findWorkspace(organizationId);
  if (fleetId === null && known?.role === "agency") return APP_HOME_HREF;
  const inPath = fleetInPath(globalThis.window?.location.pathname ?? "");
  const preferred = fleetId ?? (inPath ? resolveWorkspaceKey(inPath) : null);
  const underMandate = known && preferred && known.viaAgencyIds?.includes(preferred);
  // A requested agency frame cannot silently become another mandate or direct access.
  if (fleetId !== null && (fleetId != null || inPath) && !underMandate) return APP_HOME_HREF;
  const agency = known && fleetId !== null && (known.role === "agency" || underMandate)
    ? operatingFleetId(known, preferred) : null;
  const fleetSegment = agency ? segmentOf(agency) : null;
  if (fleetSegment) return `/o/${fleetSegment}/clients/${segment}${path === "/" ? "" : path}`;
  return `/o/${segment}${path}`;
}

/** The fleet of one agency organization; `section` asks which client opens that section. */
export function fleetHomeHref(fleetId: string, section?: string | null): string {
  const segment = segmentOf(fleetId);
  if (!segment) return FLEET_ENTRY_PATH;
  return `/o/${segment}/fleet${section ? `/choose/${encodeURIComponent(section)}` : ""}`;
}

/** Pure input rewrite preserves every existing typed workspace route. */
export function workspaceRewriteInput({ url }: { url: URL }): URL {
  const next = new URL(url);
  next.pathname = internalWorkspacePath(next.pathname);
  return next;
}
