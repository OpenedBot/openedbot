/**
 * The doors of the root.
 *
 * The public page has left the console: it lives on the public site
 * (`lib/session/public-site.ts`). `/` is the application, on every host, in a
 * tab as in the native shell: the overview, which the router opens on
 * `/o/<slug>/`. `/home` is its entry with no known organization. Without a session,
 * the `_app` shell sends to `/login` (`resolveAppFrameEntry`). Nothing here
 * depends on the host or the user agent: the same build serves the console
 * host and the bare domain during the transition.
 */
import { isAppAuthenticated, type AuthStatus } from "./auth-status";
import { APP_HOME_HREF } from "../workspace/workspace-location";

export { APP_HOME_HREF };

/**
 * Inbound rewrite of the root, before that of the workspaces:
 * `/` and `/home` open the overview (internal `/`). `null`: the URL is not one
 * of the doors, the rest decides.
 *
 * `addressPath` is the address-bar path. A `/` that is not there
 * is the INTERNAL overview that a masked history entry replays. The
 * settings overlay (`app-frame.tsx`) keeps the real location in
 * `__tempLocation`, whose internal `href` TanStack re-parses through this
 * rewrite on back, forward and reload: it falls through to the
 * workspace rewrite.
 */
export function rootRewriteInput(url: URL, addressPath: string): URL | null {
  if (url.pathname === "/" && addressPath !== "/") return null;
  if (url.pathname !== "/" && url.pathname !== APP_HOME_HREF) return null;
  const next = new URL(url);
  next.pathname = "/";
  return next;
}

/** Outbound rewrite: the overview with no organization displays as `/home`. */
export function rootRewriteOutput(pathname: string, organizationId: string | null): string | null {
  if (pathname === "/" && !organizationId) return APP_HOME_HREF;
  return null;
}

export type AppFrameEntry = { kind: "app" } | { kind: "login"; reason: string | null };

/**
 * What the `_app` shell does with a window on entry: no session means
 * `/login`. A cloud API that does not answer (`unknown`) is treated as
 * the absence of a session.
 */
export function resolveAppFrameEntry(status: AuthStatus): AppFrameEntry {
  if (isAppAuthenticated(status)) return { kind: "app" };
  return { kind: "login", reason: status.reason };
}
