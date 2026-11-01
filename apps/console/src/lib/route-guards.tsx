import { useAccountWorkspaces } from "../components/workspace/workspace-navigation";
import { WorkspaceAccessBoundary } from "../components/workspace/workspace-access-boundary";
import {
  fleetHomeHref,
  fleetInPath,
  FLEET_ENTRY_PATH,
  APP_HOME_HREF,
  internalWorkspacePath,
  isOnboardingPath,
  resolveWorkspaceKey,
  workspaceHref,
  workspaceInPath,
} from "./workspace-location";
import {
  accountAvailableWorkspaces,
  findPersonalWorkspace,
  findWorkspace,
  rememberAccountWorkspaces,
} from "./workspace-directory";
import {
  activeFleetId,
  activeOrganizationId,
  notifyWorkspaceContextChanged,
  readCloudSession,
  saveCloudSession,
} from "./cloud-session";
import {
  isOwnFleet,
  needsOrganization,
  ONBOARDING_PATH,
  ORGANIZATION_SETUP_PATH,
} from "./organization-gate";
import type { AccountWorkspacesDto } from "@openedbot/contracts-api";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { redirect, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "./api";
import { queryClient } from "./query-client";
import { proLegacyHref } from "../pro-console/registry";
import { clearPersistedQueries } from "./query-persister";
import { needsOnboarding } from "./onboarding-gate";
import { needsPasswordChange, PASSWORD_CHANGE_PATH } from "./password-change-gate";
import { ensureAuthStatus, isAppAuthenticated } from "./auth-status";
import { subscribeCloudSession } from "./cloud-session";
import { isCompactPath } from "./compact-shell";

/**
 * Tenant URLs carry the organization slug while requests still send its UUID.
 * The slug is resolved before any screen reads data, and a legacy UUID URL
 * (push, e-mail) or a URL in the wrong frame is corrected in place: a client an
 * agency operates lives under `/o/<agency>/clients/<slug>`, an ordinary
 * membership under `/o/<slug>/`, and an address a pro module published before
 * is sent where it lives now (`proLegacyHref`).
 */
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

export async function resolveWorkspaceLocation({ location }: { location: { publicHref: string } }) {
  if (typeof window === "undefined") return;
  const publicUrl = new URL(location.publicHref, window.location.origin);
  const legacy = proLegacyHref(publicUrl);
  if (legacy) throw redirect({ href: legacy, replace: true });
  const publicPath = publicUrl.pathname;
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
    resetDisabledFleetContext(account);
    known = findWorkspace(key, account.userId);
    if (!known) throw redirect({ to: "/", replace: true });
  }
  const fleetKey = fleetInPath(publicPath);
  if (fleetKey) {
    const fleetId = resolveWorkspaceKey(fleetKey, session.userId);
    if (!fleetId || !known.viaAgencyIds?.includes(fleetId)) {
      throw redirect({ to: "/", replace: true });
    }
  }
  const canonical = workspaceHref(known.id, internalWorkspacePath(publicPath), fleetKey && resolveWorkspaceKey(fleetKey, session.userId));
  if (canonical !== publicPath && window.location.pathname === publicPath) {
    window.history.replaceState(window.history.state, "", `${canonical}${window.location.search}${window.location.hash}`);
  }
}

/**
 * The frame of ONE organization. Moving to another (agency to client, client to
 * client) no longer reloads the page, so this subtree is remounted instead:
 * screens read the organization at render and two clients share the same
 * internal path (`/settings`). Personal and delegated views of the same client
 * also remount, reset the stream and read their effective privileges again.
 */
export function OrganizationFrame({ children }: { children: ReactNode }) {
  useRouterState({ select: (state) => state.location.publicHref });
  const organizationId = activeOrganizationId();
  const contextKey = `${organizationId ?? "none"}:${activeFleetId() ?? "personal"}`;
  const queryClient = useQueryClient();
  const previous = useRef(contextKey);
  useEffect(() => {
    if (previous.current === contextKey) return;
    previous.current = contextKey;
    notifyWorkspaceContextChanged();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] === "organization" && query.queryKey[1] === organizationId });
    void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  }, [contextKey, organizationId, queryClient]);
  return <Fragment key={contextKey}><WorkspaceAccessBoundary><FleetAvailabilityGate />{children}</WorkspaceAccessBoundary></Fragment>;
}

/** Keep an active page inside a personal workspace when agency access closes. */
export function FleetAvailabilityGate() {
  const account = useAccountWorkspaces();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const organizationId = activeOrganizationId();
  const session = readCloudSession();
  const featureAvailable = account.data?.agencyAvailable;
  const workspaces = account.data?.workspaces ?? [];
  const personal = workspaces.find((workspace) => workspace.kind === "personal" && workspace.role !== "agency");
  const identity = session?.csrfToken;
  const rehoming = useRef(false);

  useEffect(() => {
    if (!identity || featureAvailable !== false || rehoming.current) return;
    const currentSession = readCloudSession();
    if (!currentSession) return;
    const current = workspaces.find((workspace) => workspace.id === organizationId);
    const currentIsPersonal = current?.kind === "personal" && current.role !== "agency";
    const workspaceKey = workspaceInPath(window.location.pathname);
    const publicWorkspace = workspaceKey ? findWorkspace(workspaceKey, currentSession.userId) : null;
    const fleetRoute = pathname === FLEET_ENTRY_PATH || pathname === "/fleet" || pathname.startsWith("/fleet/");
    const clientFleetRoute = Boolean(fleetInPath(window.location.pathname));
    const organizationSetup = pathname === ORGANIZATION_SETUP_PATH || pathname.startsWith(`${ORGANIZATION_SETUP_PATH}/`);
    const onboarding = pathname === ONBOARDING_PATH || pathname.startsWith(`${ONBOARDING_PATH}/`);
    const lostWorkspace = Boolean(organizationId && !currentIsPersonal);
    const staleWorkspaceUrl = Boolean(workspaceKey && !publicWorkspace);
    const noPersonalWorkspace = !personal && !organizationSetup && !onboarding;
    if (!fleetRoute && !clientFleetRoute && !lostWorkspace && !staleWorkspaceUrl && !noPersonalWorkspace) return;

    rehoming.current = true;
    saveCloudSession({ ...currentSession, organizationId: personal?.id ?? null });
    window.location.replace(personal ? workspaceHref(personal.id, "/", null) : ONBOARDING_PATH);
  }, [featureAvailable, identity, organizationId, pathname, personal?.id, workspaces]);

  return null;
}

/**
 * Le garde des routes protégées : `beforeLoad` d'`onboardingRoute` et
 * `settingsFrameRoute` (`appFrameRoute` a le sien, qui tolère `/` sans
 * session pour la page publique).
 *
 * « Authentifié » est décidé par `lib/auth-status.ts` : une session cloud.
 * Sinon, redirection vers `/login` avec l'URL d'où l'on venait (`redirect`),
 * pour y revenir une
 * fois connecté. Le cloud API qui ne répond pas laisse passer : les écrans savent
 * déjà le dire, et un garde qui bloquerait sur une panne cacherait la panne.
 */
export async function requireAuth({ location }: { location: { href: string; pathname: string } }) {
  const status = await ensureAuthStatus();
  if (isAppAuthenticated(status)) {
    // Un mot de passe temporaire n'ouvre qu'une porte, celle qui le remplace
    // (`lib/password-change-gate.ts`).
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
 * Personnel et Agence sont deux organisations distinctes, et aucune entrée
 * n'en crée une d'office (0086) : un compte authentifié sans organisation
 * propre est envoyé sur le parcours d'accueil, dont la première étape du
 * rail est « Définir votre organisation ».
 *
 * Un compte confirmé est retenu pour la vie de la page : la question ne se
 * repose pas à chaque navigation. Une API qui ne répond pas laisse passer,
 * comme `requireAuth` : les écrans savent le dire.
 */
let organizationConfirmedFor: string | null = null;

export async function requireOrganization() {
  if (typeof window === "undefined") return;
  const session = readCloudSession();
  if (!session || (session.userId && organizationConfirmedFor === session.userId && activeOrganizationId())) return;
  const account = await api.accountWorkspacesForNavigation().catch(() => null);
  if (!account) return;
  rememberNavigationWorkspaces(account);
  resetDisabledFleetContext(account);
  const workspaces = accountAvailableWorkspaces(account);
  if (needsOrganization(workspaces)) throw redirect({ to: ONBOARDING_PATH, replace: true });
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

export function resetDisabledFleetContext(account: AccountWorkspacesDto) {
  if (account.agencyAvailable) return;
  const workspaces = accountAvailableWorkspaces(account);
  const activeId = activeOrganizationId();
  const active = workspaces.find((workspace) => workspace.id === activeId);
  if (!activeId || (active?.kind === "personal" && active.role !== "agency")) return;
  const personal = workspaces.find((workspace) => workspace.kind === "personal" && workspace.role !== "agency");
  const session = readCloudSession();
  if (session) saveCloudSession({ ...session, organizationId: personal?.id ?? null });
}

/**
 * La porte de la fenêtre, pour ce que le garde ne voit pas : un 401 nommé en
 * cours de route (session révoquée, jeton périmé), et un jeton qui change
 * (session obtenue, livraison tardive de la coque, déconnexion).
 *
 * Abonné au bus d'`cloud API-session.ts`, pas à une requête `health` racine :
 * `request()` est déjà l'unique goulot, un 401 y est vu au premier essai, et
 * une requête de plus ferait mentir tous les tests qui montent l'arbre avec
 * un `fetch` qui refuse les URL non modélisées.
 *
 * Le garde sur `pathname` n'est pas une prudence : `/login` lit lui-même le
 * cloud API (fournisseurs, sondage) et un 401 là ne doit pas le rappeler en
 * boucle. `app.render.test.tsx` le verrouille.
 *
 * Il ne réagit qu'à un CHANGEMENT, jamais à une absence confirmée. `request()`
 * appelle `clearCloudSession()` à chaque 401 nommé, y compris celui de
 * `/api/auth/me` sur une fenêtre qui n'a jamais eu de session, et le bus
 * prévient même quand rien n'a bougé. Sans cette distinction, la page publique
 * `/` était renvoyée vers `/login?redirect=%2F` par le 401 qui dit simplement
 * « pas de session » : le Retour du navigateur depuis `/login` rebondissait
 * aussitôt sur `/login`, et `/` devenait inatteignable.
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
      // Rien n'a changé, et rien n'est donc à rafraîchir ni à quitter : le 401
      // qui confirme une absence n'est pas une session perdue.
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
        const destination = new URL(window.location.href).searchParams.get("redirect");
        const target = destination && /^\/invite\/(?:fleet|member)\/[A-Za-z0-9_-]{32,128}$/.test(destination) ? destination : "/";
        void navigate({ to: target, replace: true });
      }
    };
    const unsubscribe = subscribeCloudSession(() => applySessionChange(readCloudSession() !== null));
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "ohb:cloud-session") return;
      applySessionChange(event.newValue !== null);
    };
    const onWorkspaceRevoked = async (event: Event) => {
      const { organizationId: revokedOrganizationId, fleetId: revokedFleetId } =
        (event as CustomEvent<{ organizationId: string; fleetId: string | null }>).detail;
      if (revokedOrganizationId !== activeOrganizationId() || revokedFleetId !== activeFleetId()) return;
      const session = readCloudSession();
      if (!session) return;
      queryClient.clear();
      void clearPersistedQueries();
      const account = await api.accountWorkspaces().catch(() => null);
      const currentSession = readCloudSession();
      if (!currentSession || currentSession.csrfToken !== session.csrfToken || currentSession.userId !== session.userId
        || activeOrganizationId() !== revokedOrganizationId || activeFleetId() !== revokedFleetId) return;
      if (account) {
        rememberAccountWorkspaces(account);
        const agency = fleetInPath(window.location.pathname);
        const fleetId = agency ? resolveWorkspaceKey(agency, account.userId) : null;
        const fleetWorkspace = accountAvailableWorkspaces(account).find((workspace) => workspace.id === fleetId && isOwnFleet(workspace));
        if (account.agencyAvailable && fleetWorkspace) {
          if (session) saveCloudSession({ ...session, organizationId: fleetWorkspace.id });
          window.location.replace(fleetHomeHref(fleetWorkspace.id));
          return;
        }
        const personal = accountAvailableWorkspaces(account).find((workspace) => workspace.kind === "personal" && workspace.role !== "agency");
        if (session) saveCloudSession({ ...session, organizationId: personal?.id ?? null });
        window.location.replace(personal ? workspaceHref(personal.id, "/", null) : ONBOARDING_PATH);
        return;
      }
      const personal = findPersonalWorkspace(session?.userId);
      if (session) saveCloudSession({ ...session, organizationId: personal?.id ?? null });
      window.location.replace(personal ? workspaceHref(personal.id, "/", null) : ONBOARDING_PATH);
    };
    window.addEventListener("ohb:workspace-revoked", onWorkspaceRevoked);
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("ohb:workspace-revoked", onWorkspaceRevoked);
    };
  }, [router, navigate, queryClient]);

  return null;
}

function isPublicRoute(pathname: string): boolean {
  return pathname.startsWith("/invite/fleet/")
    || pathname.startsWith("/invite/member/")
    || pathname === "/login"
    || pathname === "/legal" || pathname.startsWith("/legal/")
    // La fenêtre compacte dit elle-même que la session est perdue (`CompactFrame`).
    || isCompactPath(pathname);
}
