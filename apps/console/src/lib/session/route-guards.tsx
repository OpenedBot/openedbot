import { WorkspaceAccessBoundary } from "../../components/workspace/workspace-access-boundary";
import {
  APP_HOME_HREF,
  internalWorkspacePath,
  isOnboardingPath,
  workspaceHref,
  workspaceInPath,
} from "../workspace/workspace-location";
import {
  findPersonalWorkspace,
  findWorkspace,
  personalWorkspaces,
  rememberAccountWorkspaces,
} from "../workspace/workspace-directory";
import {
  activeOrganizationId,
  notifyWorkspaceContextChanged,
  readCloudSession,
  saveCloudSession,
} from "./cloud-session";
import { needsOrganization, ONBOARDING_PATH } from "./organization-gate";
import type { AccountWorkspacesDto } from "@openedbot/contracts-api";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { redirect, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "../api";
import { queryClient } from "../query-client";
import { clearPersistedQueries } from "../query-persister";
import { needsOnboarding } from "./onboarding-gate";
import { needsPasswordChange, PASSWORD_CHANGE_PATH } from "./password-change-gate";
import { ensureAuthStatus, isAppAuthenticated } from "./auth-status";
import { subscribeCloudSession } from "./cloud-session";
import { isCompactPath } from "../shell/compact-shell";
import { appUrl } from "../platform";

/**
 * What a guard read also seeds the query the sidebar mounts right after
 * (`useAccountWorkspaces`): one directory read per page load, not two.
 */
function rememberNavigationWorkspaces(account: AccountWorkspacesDto) {
  rememberAccountWorkspaces(account);
  // The key the hook derives, not `account.userId`: a session saved without a
  // user id (older sessions, the native shell) reads under "session".
  queryClient.setQueryData(queryKeys.accountWorkspaces(readCloudSession()?.userId ?? "session"), account);
}

/**
 * Tenant URLs carry the organization slug while requests still send its UUID.
 * The slug is resolved before any screen reads data, and a legacy UUID URL
 * (push, e-mail) is corrected in place to `/o/<slug>/`.
 */
export async function resolveWorkspaceLocation({ location }: { location: { publicHref: string } }) {
  if (typeof window === "undefined") return;
  const publicPath = appUrl(location.publicHref).pathname;
  const internalPath = internalWorkspacePath(publicPath);
  if (isOnboardingPath(internalPath)) {
    if (publicPath !== internalPath && window.location.pathname === publicPath) {
      window.history.replaceState(window.history.state, "", `${internalPath}${window.location.search}${window.location.hash}`);
    }
    return;
  }
  const key = workspaceInPath(publicPath);
  const session = readCloudSession();
  if (!key || !session) return;
  let known = findWorkspace(key, session.userId);
  if (!known) {
    const account = await api.accountWorkspacesForNavigation().catch(() => null);
    if (!account) return;
    rememberNavigationWorkspaces(account);
    resetUnavailableWorkspace(account);
    known = findWorkspace(key, account.userId);
    if (!known) throw redirect({ to: "/", replace: true });
  }
  const canonical = workspaceHref(known.id, internalWorkspacePath(publicPath));
  if (canonical !== publicPath && window.location.pathname === publicPath) {
    window.history.replaceState(window.history.state, "", `${canonical}${window.location.search}${window.location.hash}`);
  }
}

/**
 * The frame of ONE organization. Moving to another no longer reloads the page,
 * so this subtree is remounted instead: screens read the organization at render
 * and two organizations share the same internal path (`/settings`).
 */
export function OrganizationFrame({ children }: { children: ReactNode }) {
  useRouterState({ select: (state) => state.location.publicHref });
  const organizationId = activeOrganizationId();
  const contextKey = organizationId ?? "none";
  const queryClient = useQueryClient();
  const previous = useRef(contextKey);
  useEffect(() => {
    if (previous.current === contextKey) return;
    previous.current = contextKey;
    notifyWorkspaceContextChanged();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] === "organization" && query.queryKey[1] === organizationId });
    void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  }, [contextKey, organizationId, queryClient]);
  return <Fragment key={contextKey}><WorkspaceAccessBoundary>{children}</WorkspaceAccessBoundary></Fragment>;
}

/**
 * The guard of the protected routes: `beforeLoad` of `onboardingRoute` and
 * `settingsFrameRoute` (`appFrameRoute` has its own, which tolerates `/` without
 * a session for the public page).
 *
 * "Authenticated" is decided by `lib/session/auth-status.ts`: a cloud session.
 * Otherwise, redirect to `/login` with the URL one came from (`redirect`),
 * to return there once
 * signed in. A cloud API that does not answer lets it through: the screens already know
 * how to say so, and a guard that blocked on a failure would hide the failure.
 */
export async function requireAuth({ location }: { location: { href: string; pathname: string } }) {
  const status = await ensureAuthStatus();
  if (isAppAuthenticated(status)) {
    // A temporary password opens only one door, the one that replaces it
    // (`lib/session/password-change-gate.ts`).
    if (needsPasswordChange(status, location.pathname)) {
      throw redirect({ to: PASSWORD_CHANGE_PATH, replace: true });
    }
    return;
  }
  throw redirect({
    to: "/login",
    search: { redirect: location.href, reason: status.reason ?? undefined },
    replace: true,
  });
}

/**
 * No entry creates an organization by default (0086): an authenticated
 * account with no organization of its own is sent to the welcome flow, whose
 * first rail step creates it.
 *
 * A confirmed account is kept for the life of the page: the question is not
 * asked again on every navigation. An API that does not answer lets it through,
 * like `requireAuth`: the screens know how to say so.
 */
let organizationConfirmedFor: string | null = null;

export async function requireOrganization() {
  if (typeof window === "undefined") return;
  const session = readCloudSession();
  if (!session || (session.userId && organizationConfirmedFor === session.userId && activeOrganizationId())) return;
  const account = await api.accountWorkspacesForNavigation().catch(() => null);
  if (!account) return;
  rememberNavigationWorkspaces(account);
  resetUnavailableWorkspace(account);
  if (needsOrganization(account.workspaces)) throw redirect({ to: ONBOARDING_PATH, replace: true });
  organizationConfirmedFor = account.userId;
}

/** The application and settings stay closed until the account onboarding is complete. */
export async function requireCompletedOnboarding() {
  const state = await queryClient.fetchQuery({
    queryKey: queryKeys.onboarding,
    queryFn: api.onboarding,
  }).catch(() => null);
  if (needsOnboarding(state ?? undefined)) throw redirect({ to: ONBOARDING_PATH, replace: true });
}

/**
 * Starts the organization and onboarding reads before the session check
 * resolves, so the three guard reads overlap instead of chaining. The guards
 * below still await and decide in order; they reuse these in-flight reads
 * (`sharedRead` for the directory, the query cache for onboarding). A 401
 * here changes nothing: `/api/auth/me` answers the same.
 */
export function warmAppAccess() {
  if (typeof window === "undefined") return;
  const session = readCloudSession();
  if (!session) return;
  if (!(session.userId && organizationConfirmedFor === session.userId && activeOrganizationId())) {
    void api.accountWorkspacesForNavigation().catch(() => null);
  }
  if (activeOrganizationId()) {
    void queryClient.prefetchQuery({ queryKey: queryKeys.onboarding, queryFn: api.onboarding });
  }
}

export async function requireAppAccess() {
  await requireOrganization();
  await requireCompletedOnboarding();
}

/** A session left on an organization the account can no longer open moves to its personal workspace. */
function resetUnavailableWorkspace(account: AccountWorkspacesDto) {
  const activeId = activeOrganizationId();
  const workspaces = personalWorkspaces(account.workspaces);
  if (!activeId || workspaces.some((workspace) => workspace.id === activeId)) return;
  const session = readCloudSession();
  if (session) saveCloudSession({ ...session, organizationId: workspaces[0]?.id ?? null });
}

/**
 * The window's door, for what the guard does not see: a named 401 along
 * the way (revoked session, expired token), and a token that changes
 * (session obtained, late delivery by the shell, sign-out).
 *
 * Subscribed to the bus of `cloud API-session.ts`, not to a root `health` request:
 * `request()` is already the single bottleneck, a 401 is seen there on the first try, and
 * one more request would make every test that mounts the tree with
 * a `fetch` that refuses unmodeled URLs lie.
 *
 * The guard on `pathname` is not caution: `/login` itself reads the
 * cloud API (providers, probe) and a 401 there must not call it back in
 * a loop. `app.render.test.tsx` locks that in.
 *
 * It reacts only to a CHANGE, never to a confirmed absence. `request()`
 * calls `clearCloudSession()` on every named 401, including that of
 * `/api/auth/me` on a window that never had a session, and the bus
 * notifies even when nothing moved. Without this distinction, the public page
 * `/` was sent to `/login?redirect=%2F` by the 401 that simply says
 * "no session": the browser's Back from `/login` bounced
 * straight back to `/login`, and `/` became unreachable.
 */
export function CloudSessionGate() {
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hadSession = useRef(readCloudSession() !== null);
  const identity = useRef(readCloudSession()?.csrfToken ?? null);

  useEffect(() => {
    const applySessionChange = (hasSession: boolean) => {
      const nextIdentity = readCloudSession()?.csrfToken ?? null;
      const replaced = hadSession.current && hasSession && nextIdentity !== identity.current;
      identity.current = nextIdentity;
      if (replaced) {
        queryClient.clear();
        void clearPersistedQueries();
        window.location.replace(APP_HOME_HREF);
        return;
      }
      const changed = hasSession !== hadSession.current;
      hadSession.current = hasSession;
      // Nothing changed, so there is nothing to refresh or to leave: the 401
      // that confirms an absence is not a lost session.
      if (!changed) return;
      if (!hasSession) {
        queryClient.clear();
        void clearPersistedQueries();
      }
      else void queryClient.invalidateQueries();
      const { pathname, href } = router.state.location;
      if (!hasSession && !isPublicRoute(pathname)) {
        void navigate({ to: "/login", search: { redirect: href }, replace: true });
      } else if (hasSession && pathname === "/login") {
        // Signed in from a member invitation: back to it, and only to it.
        const destination = new URL(window.location.href).searchParams.get("redirect");
        void navigate({ to: destination && MEMBER_INVITATION_PATH.test(destination) ? destination : "/", replace: true });
      }
    };
    const unsubscribe = subscribeCloudSession(() => applySessionChange(readCloudSession() !== null));
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "openedbot:cloud-session") return;
      applySessionChange(event.newValue !== null);
    };
    const onWorkspaceRevoked = async (event: Event) => {
      const { organizationId: revokedOrganizationId } = (event as CustomEvent<{ organizationId: string }>).detail;
      if (revokedOrganizationId !== activeOrganizationId()) return;
      const session = readCloudSession();
      if (!session) return;
      queryClient.clear();
      void clearPersistedQueries();
      const account = await api.accountWorkspaces().catch(() => null);
      const currentSession = readCloudSession();
      if (!currentSession || currentSession.csrfToken !== session.csrfToken || currentSession.userId !== session.userId
        || activeOrganizationId() !== revokedOrganizationId) return;
      if (account) rememberAccountWorkspaces(account);
      const personal = account ? personalWorkspaces(account.workspaces)[0] ?? null : findPersonalWorkspace(session.userId);
      saveCloudSession({ ...session, organizationId: personal?.id ?? null });
      window.location.replace(personal ? workspaceHref(personal.id) : ONBOARDING_PATH);
    };
    window.addEventListener("openedbot:workspace-revoked", onWorkspaceRevoked);
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("openedbot:workspace-revoked", onWorkspaceRevoked);
    };
  }, [router, navigate, queryClient]);

  return null;
}

const MEMBER_INVITATION_PATH = /^\/invite\/member\/[A-Za-z0-9_-]{32,128}$/;

function isPublicRoute(pathname: string): boolean {
  return pathname.startsWith("/invite/member/")
    || pathname === "/login"
    || pathname === "/legal" || pathname.startsWith("/legal/")
    // The compact window itself says that the session is lost (`CompactFrame`).
    || isCompactPath(pathname);
}
