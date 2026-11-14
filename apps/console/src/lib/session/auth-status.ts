/**
 * What the window IS to the cloud API, and whether the application lets it in.
 *
 * Two reads, one decision (`isAppAuthenticated`):
 * - does the cloud API offer SSO (`GET /api/auth/providers`, public);
 * - what is this window authenticated by (`GET /api/auth/me`): a
 *   cloud session, or nothing (401).
 *
 * The cloud-only rule is strict: the application always requires a user
 * session, whatever the client or the configured identity provider.
 *
 * `unknown`: the cloud API did not answer (not there yet, cut off). It is let
 * through: the screens already know how to show « cloud API injoignable », and a guard
 * that blocked on a failure would hide the failure. Never cached.
 *
 * Cached until the token changes or a 401 lands
 * (the cloud session notifies): the route guard (`route-tree.tsx`)
 * calls it on every navigation and must not cost a request every time.
 */
import type { AuthUserDto } from "@openedbot/contracts-api";
import { api, isUnauthorized, queryKeys } from "../api";
import { subscribeCloudSession } from "./cloud-session";
import { queryClient } from "../query-client";

export type AuthStatus = {
  kind: "session" | "none" | "unknown";
  ssoEnabled: boolean;
  user: AuthUserDto | null;
  sessionId: string | null;
  /** For `none`: the 401 code (`UNAUTHORIZED`, `SESSION_EXPIRED`, `SESSION_REVOKED`): `/login` names the reason. */
  reason: string | null;
  /**
   * The account was created by the team with a temporary password, and has not
   * replaced it yet (`users.must_change_password`). The route guard
   * then opens only the security screen: « temporaire » is a fact only if
   * the application holds it. Always `false` outside a session.
   */
  mustChangePassword: boolean;
};

export const UNKNOWN_AUTH_STATUS: AuthStatus = { kind: "unknown", ssoEnabled: false, user: null, sessionId: null, reason: null, mustChangePassword: false };

export function isAppAuthenticated(status: AuthStatus): boolean {
  if (status.kind === "session") return true;
  return false;
}

let cached: Promise<AuthStatus> | null = null;

/** Same mapping as `api.authStatus`, as a seed of the React Query cache. */
async function loadAuthStatusFromQuery(): Promise<AuthStatus> {
  try {
    const me = await queryClient.fetchQuery({
      queryKey: queryKeys.authMe,
      queryFn: api.authMe,
      staleTime: 10_000,
    });
    if (me.kind !== "session") {
      return { kind: "none", ssoEnabled: true, user: null, sessionId: null, reason: "AUTH_REQUIRED", mustChangePassword: false };
    }
    return {
      kind: "session",
      ssoEnabled: true,
      user: me.user,
      sessionId: me.sessionId,
      reason: null,
      mustChangePassword: me.mustChangePassword === true,
    };
  } catch (error) {
    if (isUnauthorized(error)) {
      return { kind: "none", ssoEnabled: true, user: null, sessionId: null, reason: error.code ?? null, mustChangePassword: false };
    }
    throw error;
  }
}

export function ensureAuthStatus(load: () => Promise<AuthStatus> = loadAuthStatusFromQuery): Promise<AuthStatus> {
  if (!cached) {
    const promise = load().catch(() => UNKNOWN_AUTH_STATUS);
    cached = promise;
    // A failure is not cached: the next navigation asks again.
    void promise.then((status) => {
      if (status.kind === "unknown" && cached === promise) cached = null;
    });
  }
  return cached;
}

export function resetAuthStatus() {
  cached = null;
}

subscribeCloudSession(resetAuthStatus);

// A token that changes or a 401 makes the previous answer stale.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === "openedbot:cloud-session") resetAuthStatus();
  });
}
