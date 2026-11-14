import { isUuid } from "@openedbot/contracts-primitives";
import { findWorkspace } from "./workspace-directory";

/**
 * `/o/<slug>` (or a legacy `/o/<uuid>`). The slug shape mirrors
 * `organizations_slug_url_segment` (0085).
 */
const SLUG = "[a-z0-9][a-z0-9-]{0,62}";
const PREFIX = new RegExp(`^/o/(${SLUG})(?=/|$)`, "i");
const SEGMENT = new RegExp(`^${SLUG}$`, "i");

/**
 * Entry of the app when no workspace URL can be built: like `/`, the router
 * rewrites it to the overview (`public-landing-gate.ts`).
 */
export const APP_HOME_HREF = "/home";

/** The organization a URL designates. */
export function workspaceInPath(path: string): string | null {
  return path.match(PREFIX)?.[1] ?? null;
}

/** The organization UUID a URL segment designates, or `null` while its slug is unknown. */
export function resolveWorkspaceKey(key: string, userId?: string): string | null {
  return findWorkspace(key, userId)?.id ?? (isUuid(key) ? key : null);
}

/** The frame prefix of a public URL (`/o/<org>`), `""` outside a workspace. */
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
  return path === "/" || /^\/(bot|g|inbox|settings|decisions|c|cs)(\/|$)/.test(path);
}

function segmentOf(organizationId: string): string | null {
  const segment = findWorkspace(organizationId)?.slug ?? (isUuid(organizationId) ? organizationId : null);
  return segment && SEGMENT.test(segment) ? segment : null;
}

/** Public URL of a workspace route: `/o/<slug><path>`. */
export function workspaceHref(organizationId: string, path = "/"): string {
  if (!path.startsWith("/") || path.startsWith("//")) return APP_HOME_HREF;
  if (isOnboardingPath(path)) return path;
  const segment = segmentOf(organizationId);
  if (!segment) return APP_HOME_HREF;
  return `/o/${segment}${path}`;
}

/** Pure input rewrite preserves every existing typed workspace route. */
export function workspaceRewriteInput({ url }: { url: URL }): URL {
  const next = new URL(url);
  next.pathname = internalWorkspacePath(next.pathname);
  return next;
}
