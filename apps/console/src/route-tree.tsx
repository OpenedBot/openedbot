import { internalWorkspacePath, isWorkspacePath, workspaceHref, workspaceRewriteInput } from "./lib/workspace/workspace-location";
import { activeOrganizationId, readCloudSession } from "./lib/session/cloud-session";
import { Suspense, useEffect, useRef } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  isRedirect,
  lazyRouteComponent,
  Navigate,
  Outlet,
  redirect,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { SkeletonRegion, useIsMobile } from "@openedbot/browser-ui-kit";
import { AppErrorScreen } from "./components/app-error-boundary";
import { clearAppAccessHint, hasAppAccessHint, markAppAccess } from "./lib/session/app-access-hint";
import { NotFoundScreen } from "./components/app-not-found";
import { AppFrameSkeleton } from "./components/skeletons/frame-skeletons";
import { proConsole, proFeatureEntitled } from "./pro-console/registry";
import { Shell } from "./components/shell";
import { mobileTransition } from "./lib/shell/mobile-navigation";
import { consumeMobileLanding, firstRosterBotId, isMobileLandingConsumed } from "./lib/shell/mobile-landing";
import { SiteHeader } from "./components/dashboard/site-header";
import { api, queryKeys } from "./lib/api";
import { queryClient } from "./lib/query-client";
import { resolveLegacyConversation } from "./lib/thread/conversation-href";
import { prefetchConversation, prefetchConversationForPath, restoreConversationForPath } from "./lib/thread/conversation-prefetch";
import { conversationSearch, inboxSearch, loginSearch, onboardingSearch } from "./lib/shell/route-search";
import { groupRoutes } from "./group-routes";
import { SHOW_DEV_SETTINGS } from "./lib/shell/dev-settings-ui";
import { needsOnboarding } from "./lib/session/onboarding-gate";
import { needsPasswordChange, PASSWORD_CHANGE_PATH } from "./lib/session/password-change-gate";
import { resolveAppFrameEntry, rootRewriteInput, rootRewriteOutput } from "./lib/session/public-landing-gate";
import { ensureAuthStatus, isAppAuthenticated } from "./lib/session/auth-status";
import { subscribeCloudSession } from "./lib/session/cloud-session";
import { useT } from "./lib/i18n";
import { ConversationPending } from "./components/thread-skeleton";
import { isPendingBotId } from "./lib/bots/pending-bot-creations";
import { isRuntimeSection, type RuntimeSection } from "./screens/settings/installation/cloud/cloud-shared";
import { SETTINGS_SECTIONS, SettingsBodySkeleton } from "./screens/settings/sections";
import { WebWorkflowNotificationBridge } from "./components/web-workflow-notification-bridge";
import { BrowserTabMetadata } from "./components/browser-tab-metadata";
import { CompactEmpty } from "./components/compact/compact-frame";
import { nativeAuth, nativeBridge } from "./lib/platform";
import { COMPACT_PATH, primeNativeSession, readCompactLastBot } from "./lib/shell/compact-shell";
import { CloudSessionGate, OrganizationFrame, requireAppAccess, warmAppAccess, requireAuth, resolveWorkspaceLocation } from "./lib/session/route-guards";
import { LoginRoute } from "./screens/auth/login-route";
import { AppFrame } from "./components/frames/app-frame";
import { CompactFrameEntry } from "./components/frames/compact-frame-entry";
import { SettingsFrame } from "./components/frames/settings-frame";

// Every screen but the frame is its own chunk, loaded when its route matches
// (TanStack `lazyRouteComponent`, preloaded by the router before render), the
// conversation included: a refresh evaluates no other screen,
// and the thread list never waits for the composer, the timeline or markdown.
const ConversationScreen = lazyRouteComponent(() => import("./screens/conversation/conversation"), "ConversationScreen");
const BotCreatingScreen = lazyRouteComponent(() => import("./components/bot-create/bot-creating-screen"), "BotCreatingScreen");
const MobileSettingsScreen = lazyRouteComponent(() => import("./components/mobile/mobile-settings-screen"), "MobileSettingsScreen");
const InboxScreen = lazyRouteComponent(() => import("./screens/conversation/inbox"), "InboxScreen");
const MemberInvitationScreen = lazyRouteComponent(() => import("./screens/auth/member-invitation"), "MemberInvitationScreen");
const ChangePasswordScreen = lazyRouteComponent(() => import("./screens/auth/change-password"), "ChangePasswordScreen");
const OnboardingScreen = lazyRouteComponent(() => import("./screens/onboarding"), "OnboardingScreen");
const OverviewScreen = lazyRouteComponent(() => import("./screens/home/overview"), "OverviewScreen");
const ModeLanding = lazyRouteComponent(() => import("./screens/public/landing"), "ModeLanding");
const LegalScreen = lazyRouteComponent(() => import("./screens/public/legal"), "LegalScreen");
const CloudRuntimeSettings = lazyRouteComponent(() => import("./screens/settings/installation/cloud"), "CloudRuntimeSettings");

const rootRoute = createRootRoute({
  beforeLoad: resolveWorkspaceLocation,
  component: () => (
    <Shell>
      <CloudSessionGate />
      <OrganizationFrame>
        <BrowserTabMetadata />
        <WebWorkflowNotificationBridge />
        <Outlet />
      </OrganizationFrame>
    </Shell>
  ),
});

/**
 * `/login`: outside the protected routes, and it sends an already
 * authenticated window back to the application (returning to `/login` from a
 * bookmark must not show a button for something already done).
 */
/** A member invitation, answered by its token: outside the guarded frames, the invitee may have no workspace. */
const memberInvitationRoute = createRoute({ getParentRoute: () => rootRoute, path: "/invite/member/$token", component: MemberInvitationScreen });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: loginSearch,
  beforeLoad: async ({ search }) => {
    const status = await ensureAuthStatus();
    if (status.kind !== "unknown" && isAppAuthenticated(status)) {
      const { clearPendingAttempt } = await import("./screens/auth/login");
      clearPendingAttempt();
      const target = search.redirect && search.redirect.startsWith("/") ? search.redirect : "/";
      throw redirect({ to: target, replace: true });
    }
    // Native shell: the session comes from its tokens. A shell that can carry
    // the sign-in (`nativeAuth`) stays here and goes through its bridge; an
    // older one takes over and shows its local page. An unreachable API
    // (`unknown`) clears nothing: that is not a refusal.
    const bridge = nativeBridge();
    if (bridge && !nativeAuth() && status.kind === "none") await bridge.signOut();
  },
  component: LoginRoute,
});

/**
 * `/change-password`: the FIRST sign-in of an account set up by the team.
 *
 * Outside the application and settings frames, on purpose. The guard sends
 * there anyone who still carries a temporary password
 * (`lib/session/password-change-gate.ts`); this screen has one thing to do.
 *
 * Two redirects, and they keep the screen honest: with no session we go back
 * to `/login`, and an account that has nothing left to change goes back to
 * the application. Without the second, this address would become a second
 * password-change screen, competing with `/settings/security`, reachable
 * from a bookmark and with nothing to say why it opens.
 */
const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/change-password",
  beforeLoad: async ({ location }) => {
    const status = await ensureAuthStatus();
    if (!isAppAuthenticated(status)) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href, reason: status.reason ?? undefined },
        replace: true,
      });
    }
    if (!status.mustChangePassword) throw redirect({ to: "/", replace: true });
  },
  component: ChangePasswordRoute,
});

function ChangePasswordRoute() {
  const navigate = useNavigate();
  // `replace`: the temporary password no longer exists, and the
  // « précédent » button must not bring back a screen that would redirect at once.
  return <ChangePasswordScreen onDone={() => void navigate({ to: "/", replace: true })} />;
}

const legalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/legal/$slug",
  component: LegalScreen,
});

/**
 * The frame of the application screens: conversation bar + inset.
 *
 * Pathless route (`id` only): it adds nothing to the URL, it only
 * wraps its children. `Sidebar` and `SidebarInset` must stay siblings
 * in the DOM: the `peer-data-*` selectors in `sidebar.tsx` depend on that to
 * shift the inset when the bar collapses.
 *
 * `collapsible="icon"` rather than `offcanvas`: collapsed, the bar keeps a rail
 * of faces, conversations stay one click away instead of
 * disappearing: that is the whole point of collapsing it.
 */
/** The last frame path whose guards have passed (see `beforeLoad`). */
let guardedAppPath: string | null = null;
subscribeCloudSession(() => {
  guardedAppPath = null;
});

/** Show the application chrome only after its access guards have passed. */
function AppAccessPending() {
  const { t } = useT();
  return guardedAppPath ? <AppFrameSkeleton /> : (
    <SkeletonRegion label={t("common.loading")} className="flex h-full min-h-0 w-full flex-1 items-center justify-center bg-background">
      <span className="text-caption text-muted-foreground">{t("common.loading")}</span>
    </SkeletonRegion>
  );
}

/**
 * The app frame's access guards: session, temporary password, organization,
 * completed onboarding. Throws the redirect a failing guard asks for; marks
 * this user's access on success.
 */
async function guardAppFrame(location: { href: string; pathname: string }): Promise<void> {
  const status = await ensureAuthStatus();
  const entry = resolveAppFrameEntry(status);
  if (entry.kind === "login") {
    throw redirect({
      to: "/login",
      search: { redirect: location.href, reason: entry.reason ?? undefined },
      replace: true,
    });
  }
  // The same guard as `requireAuth`: the application shell opens nothing
  // until a temporary password has been replaced.
  if (needsPasswordChange(status, location.pathname)) {
    throw redirect({ to: PASSWORD_CHANGE_PATH, replace: true });
  }
  await requireAppAccess();
  markAppAccess(readCloudSession()?.userId);
}

const appFrameRoute = createRoute({
  getParentRoute: () => rootRoute,
  // Leading `_`: the TanStack convention for a pathless route. It
  // does not appear in the URL but it does appear in route ids, hence
  // `from: "/_app/bot/$botId"` / `"/_app/cs/$botId"` on the conversation screen.
  id: "_app",
  /**
   * The same guard as `requireAuth`. The public page is no longer in the
   * console: it lives on the public site (`lib/session/public-site.ts`).
   */
  beforeLoad: async ({ location, cause }) => {
    // Opening or closing the settings overlay only changes history
    // state: same route, same screen. Replaying the guards restarted
    // `/api/onboarding` and re-rendered the frame during the animation. A
    // session that expired in the meantime is still caught by the 401 (`lib/api.ts`).
    if (cause === "stay" && guardedAppPath === location.pathname) return;
    guardedAppPath = null;
    // Not awaited: the guard reads and the conversation reads start together,
    // instead of the loader waiting for session, organization and onboarding.
    warmAppAccess();
    // The cached conversation first, so the frame never paints it as skeletons.
    await restoreConversationForPath(location.pathname, location.search);
    prefetchConversationForPath(location.pathname, location.search);
    // Guards already passed for this user on this browser: open the frame on
    // the cached roster and threads now, check behind it, and redirect only if
    // a guard fails (`lib/session/app-access-hint.ts`).
    if (hasAppAccessHint(readCloudSession()?.userId)) {
      guardedAppPath = location.pathname;
      void guardAppFrame(location).catch((error: unknown) => {
        guardedAppPath = null;
        clearAppAccessHint();
        if (isRedirect(error)) void router.navigate({ ...error.options, replace: true });
      });
      return;
    }
    await guardAppFrame(location);
    guardedAppPath = location.pathname;
  },
  component: AppFrame,
  // The destination can still be login or onboarding while guards resolve.
  // Keep that wait neutral; paint the app silhouette only after access passes.
  pendingComponent: AppAccessPending,
});


/**
 * The overview: cards, chart, table. It gives way to the welcome flow
 * until that flow has been finished.
 *
 * ONE trigger, and only one: `completed === false` (`needsOnboarding`),
 * that is, the cloud API saying "this person has not yet left
 * the welcome flow". The earlier rules: empty registry, missing operator profile:
 * inferred it from a state that can legitimately happen again later (one
 * deletes one's last runtime without wanting to redo the welcome flow). Leaving
 * is a fact PER PERSON (`users.onboarding_completed`), and the three paths
 * that lead there (`full`, `runtime_skipped`, `skip_existing`) all set it;
 * `onboardedAt`, the dated exit of the space, stays informational.
 */
const indexRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/",
  component: IndexRoute,
  // The overview's chunk loads: the frame is already there, only the content
  // waits. Its header depends on nothing, it is painted as it is; no shape
  // promises the scene below.
  pendingComponent: IndexPending,
});

/** The Salon header, the same as `OverviewScreen`'s, without the scene. */
function IndexPending() {
  const { t } = useT();
  const isMobile = useIsMobile();
  return (
    <div className="openedbot-salon-shell relative flex min-h-0 flex-1 flex-col">
      <SiteHeader title={t("overviewPlaceholder.nav")} heading={isMobile} align="center" root />
    </div>
  );
}

function IndexRoute() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const onboarding = useQuery({ queryKey: queryKeys.onboarding, queryFn: api.onboarding });
  // Neither while loading, nor on error: a read that did not succeed (cloud API not
  // ready yet) proves nothing, and redirecting on it would send the user to redo a
  // flow already done on every slow cloud API restart. `false`
  // STRICTLY is the cloud API saying "this field exists and this person
  // has not left yet"; `undefined`: a cloud API from before the flag: says nothing.
  const toOnboarding =
    !onboarding.isPending && !onboarding.error && needsOnboarding(onboarding.data);

  // SAME key as the panel: on a phone the drawer mounts the roster in the
  // same frame, arrival reads its cache and adds no request.
  const roster = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    enabled: isMobile && !toOnboarding,
  });
  /**
   * A conversation app opens on a thread, not on a dashboard:
   * on ARRIVAL (the first `/` of the load), a non-empty registry selects
   * the first bot in the panel. Empty registry: or a failed read: and we
   * stay on the overview, which carries « Nouveau bot ».
   *
   * The latch is read once on mount: « Aperçu » in the operator menu
   * must stay reachable afterwards, and a switch during render would
   * change what this component returns.
   */
  const isArrival = useRef(!isMobileLandingConsumed()).current;
  const autoBotId = isMobile && isArrival && roster.isSuccess ? firstRosterBotId(roster.data.bots) : null;
  const awaitingArrival = isMobile && isArrival && !toOnboarding && (onboarding.isPending || roster.isPending);

  useEffect(() => {
    if (toOnboarding) {
      void navigate({ to: "/onboarding", replace: true });
      return;
    }
    if (!isMobile || !isArrival || awaitingArrival) return;
    // Decided once: a roster that fails at launch stays on
    // the overview, it does not arm a jump on the next success.
    if (!consumeMobileLanding()) return;
    if (autoBotId) void navigate({ to: "/bot/$botId", params: { botId: autoBotId }, search: {}, replace: true });
  }, [toOnboarding, isMobile, isArrival, awaitingArrival, autoBotId, navigate]);

  if (toOnboarding) return null;
  // Nothing rather than an overview that jumps: the scene is already under the
  // drawer header, and the redirect lands right after.
  if (awaitingArrival || autoBotId) return null;

  // The header lives in the screen: on a phone it carries the "+" that opens the
  // same « Nouveau bot » sheet as the scene, and it reads that scene's scroll.
  return (
    <div className="openedbot-salon-shell relative flex min-h-0 flex-1 flex-col">
      <OverviewScreen />
    </div>
  );
}

/** The welcome flow, outside the `appFrameRoute` frame: no sidebar while there is nothing to put in it. */
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  beforeLoad: async ({ location }) => {
    await requireAuth({ location });
  },
  /**
   * `review=1`: the VOLUNTARY entry (« Revoir l'accueil » on the
   * Overview). Without it, a person who has already finished the welcome flow is
   * sent back to `/`: the flow is per person (`completed`), and a
   * new sign-in must never show it again.
   */
  validateSearch: onboardingSearch,
  component: OnboardingScreen,
});

/**
 * Former `/decisions`: the journal now lives in settings.
 * A bookmark or an internal link must not 404.
 */
const decisionsLegacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/decisions",
  beforeLoad: () => {
    throw redirect({ to: "/settings/decisions", replace: true });
  },
});

/** Former `/inbox`: « À traiter » now lives in settings (09-11-2026); the filter follows. */
const inboxLegacyRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/inbox",
  validateSearch: inboxSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/inbox", search, replace: true });
  },
});

function BotLandingRoute() {
  const { t } = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SiteHeader title={t("modeLanding.bot.nav")} heading={false} />
      <ModeLanding />
    </div>
  );
}

/** Home of Bot mode: `/bot`. An open bot lives under `/bot/:botId`. */
const botLandingRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/bot",
  component: BotLandingRoute,
});

/**
 * Former home of the extra sessions. A bot has only one thread now: `/cs` sends
 * back to the registry rather than rendering a dead bookmark.
 */
const chatLandingRedirectRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/cs",
  beforeLoad: () => { throw redirect({ to: "/bot" }); },
});

/** A bot's forever-chat: `/bot/:botId`. The header is rendered by the screen. */
const botConversationRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/bot/$botId",
  validateSearch: conversationSearch,
  loaderDeps: ({ search }) => ({ task: search.task }),
  // Not awaited: the screen's chunk, the roster and the thread start now; the
  // screen renders without waiting and reads the same cache entries.
  loader: ({ params, deps }) => {
    void (isPendingBotId(params.botId) ? BotCreatingScreen : ConversationScreen).preload?.();
    if (!isPendingBotId(params.botId)) prefetchConversation(params.botId, deps.task);
  },
  component: BotConversationEntry,
});

/** A bot being created (`lib/bots/pending-bot-creations.ts`) does not have a thread yet. */
function BotConversationEntry() {
  const { botId } = botConversationRoute.useParams();
  return <Suspense fallback={<ConversationPending />}>{isPendingBotId(botId) ? <BotCreatingScreen botId={botId} /> : <ConversationScreen />}</Suspense>;
}

/**
 * Dev server only (`screens/dev/`): `/dev/thread-lab` (thread vs prototype on a
 * scripted stream), `/dev/math` (math + mermaid fixture), `/dev/ui` (toasts and
 * shared UI, light and dark). A build turns `import.meta.env.DEV` into `false`
 * and drops routes and chunks; `=== true` for the reason in `dev-settings-ui.ts`.
 */
const devRoutes = import.meta.env.DEV === true
  ? [
      createRoute({ getParentRoute: () => appFrameRoute, path: "/dev/thread-lab", component: lazyRouteComponent(() => import("./screens/dev/thread-lab"), "ThreadLabScreen") }),
      createRoute({ getParentRoute: () => appFrameRoute, path: "/dev/math", component: lazyRouteComponent(() => import("./screens/dev/math-lab"), "MathLabScreen") }),
      createRoute({ getParentRoute: () => appFrameRoute, path: "/dev/ui", component: lazyRouteComponent(() => import("./screens/dev/ui-lab"), "UiLabScreen") }),
    ]
  : [];

/** Former extra session: `/cs/:botId?task=`. The bot has only one thread now. */
const chatSessionRedirectRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/cs/$botId",
  validateSearch: conversationSearch,
  // `?task=` survives the redirect: it is now a message-variant
  // branch, not a session, and it lives under `/bot/:botId`.
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/bot/$botId", params: { botId: params.botId }, search });
  },
});

/**
 * Former `/c/:slug`. Resolves the slug once, then redirects. An unknown slug
 * is not guessed onto `/bot`: we show « bot disparu ».
 */
const conversationLegacyRoute = createRoute({
  getParentRoute: () => appFrameRoute,
  path: "/c/$botSlug",
  validateSearch: conversationSearch,
  beforeLoad: async ({ params, search }) => {
    const roster = await api.roster();
    const next = resolveLegacyConversation(params.botSlug, search, roster.bots);
    if (!next) return;
    throw redirect({ ...next, replace: true });
  },
  component: ConversationLegacyGone,
});

function ConversationLegacyGone() {
  const { t } = useT();
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {t("conversation.botGone")}
    </div>
  );
}

/**
 * The settings frame, with ITS bar: on the opentrack model, where
 * settings deliberately live outside the main shell.
 *
 * Keeping the bot list here said nothing about where one is and
 * left no room for the sections.
 */
const settingsFrameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: async ({ location }) => {
    await requireAuth({ location });
    await requireAppAccess();
  },
  component: SettingsFrame,
});


/** `/settings`: the phone's list of sections; on desktop, Activity moved to `/settings/activity` (08-11-2026). */
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/",
  component: SettingsIndexRoute,
});

function SettingsIndexRoute() {
  const { t } = useT();
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <>
        <SiteHeader title={t("mobileShell.settings")} />
        <MobileSettingsScreen />
      </>
    );
  }
  return <Navigate to="/settings/activity" replace />;
}

const activitySettingsRoute = createRoute({ getParentRoute: () => settingsFrameRoute, path: "/activity", component: SETTINGS_SECTIONS["/settings/activity"] });

/** The account and its organization's members; the legacy organization URL opens it too. */
const accountSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/account",
  component: SETTINGS_SECTIONS["/settings/account"],
});

const organizationSettingsRedirectRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/organization",
  beforeLoad: () => {
    throw redirect({ to: "/settings/account", replace: true });
  },
});

/**
 * The Hermes runtime: the registry, and the detail of the selected runtime. The
 * section lives in the URL (`?section=status|runtimes`): a tab can be shared
 * and reloaded. The old `?section=agents` falls back to `/settings/agents`.
 * The screen mounts bare in tests, without a `RouterProvider`.
 */
const runtimeSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/runtime",
  validateSearch: (search: Record<string, unknown>): { section?: RuntimeSection | "agents" } =>
    search.section === "agents" || isRuntimeSection(search.section) ? { section: search.section } : {},
  beforeLoad: ({ search }) => {
    if (search.section === "agents") throw redirect({ to: "/settings/agents", replace: true });
  },
  component: RuntimeSettingsRoute,
});

function RuntimeSettingsRoute() {
  const { t } = useT();
  const { section } = useSearch({ from: "/settings/runtime" });
  const navigate = useNavigate();
  const runtimeSection = section === "agents" ? undefined : section;
  return (
    <>
      <SiteHeader title={t("settingsSidebar.runtime")} />
      {/* Without a local boundary, the module load bubbles to the root and blanks the whole window. */}
      <Suspense fallback={<SettingsBodySkeleton />}>
        <CloudRuntimeSettings
          section={runtimeSection}
          onSectionChange={(next) => {
            void navigate({ to: "/settings/runtime", search: { section: next }, replace: true });
          }}
        />
      </Suspense>
    </>
  );
}

/**
 * Hermes agent import: profiles already on the host, or an archive. It was
 * the Agents tab of `/settings/runtime`; a page, like Connectors.
 */
const agentsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/agents",
  component: SETTINGS_SECTIONS["/settings/agents"],
});

const modelsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/models",
  component: SETTINGS_SECTIONS["/settings/models"],
});

const appearanceSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/appearance",
  component: SETTINGS_SECTIONS["/settings/appearance"],
});

/**
 * Archives: archived bots and hidden conversations. A settings
 * destination rather than two folds at the bottom of the sidebar: what one puts away
 * is found where one manages, not in the list of what is alive.
 */
const archivesSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/archives",
  component: SETTINGS_SECTIONS["/settings/archives"],
});

const connectorsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/connectors",
  component: SETTINGS_SECTIONS["/settings/connectors"],
});

const notificationsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/notifications",
  component: SETTINGS_SECTIONS["/settings/notifications"],
});

/** The « À traiter » box. The header is rendered by the screen (filters). */
const inboxSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/inbox",
  validateSearch: inboxSearch,
  component: InboxScreen,
});

const decisionsSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/decisions",
  component: SETTINGS_SECTIONS["/settings/decisions"],
});

const policiesSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/policies",
  component: SETTINGS_SECTIONS["/settings/policies"],
});

const securitySettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/security",
  component: SETTINGS_SECTIONS["/settings/security"],
});

const billingSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/billing",
  beforeLoad: async () => {
    if (!SHOW_DEV_SETTINGS || !(await proFeatureEntitled("billing"))) throw redirect({ to: "/settings", replace: true });
  },
  component: SETTINGS_SECTIONS["/settings/billing"],
});

const developerSettingsRoute = createRoute({
  getParentRoute: () => settingsFrameRoute,
  path: "/developer",
  beforeLoad: () => {
    if (!SHOW_DEV_SETTINGS) throw redirect({ to: "/settings", replace: true });
  },
  component: SETTINGS_SECTIONS["/settings/developer"],
});

export /**
 * The compact window (DEV-139): `/compact` reopens the last bot,
 * `/compact/:botId` is that bot's thread, with no product chrome. In the
 * native shell, identity comes from the bridge (`lib/platform/native-bridge.ts`) and the
 * cloud session is set from `/api/auth/me`; in a browser, the same
 * guard as the protected routes (cookie).
 */
const compactFrameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: COMPACT_PATH,
  beforeLoad: async ({ location }) => {
    const bridge = nativeBridge();
    if (bridge) {
      const token = await bridge.readAccessToken();
      if (!token || !(await primeNativeSession())) return { signedOut: true };
      return { signedOut: false };
    }
    await requireAuth({ location });
    return { signedOut: false };
  },
  component: CompactFrameEntry,
});


const compactIndexRoute = createRoute({
  getParentRoute: () => compactFrameRoute,
  path: "/",
  beforeLoad: async ({ context }) => {
    if (context.signedOut) return;
    const roster = await queryClient.fetchQuery({ queryKey: queryKeys.roster, queryFn: api.roster }).catch(() => null);
    if (!roster) return;
    const remembered = readCompactLastBot();
    const kept = roster.bots.find((bot) => bot.id === remembered && bot.archivedAt === null);
    const botId = kept?.id ?? firstRosterBotId(roster.bots);
    if (botId) throw redirect({ to: "/compact/$botId", params: { botId }, replace: true });
  },
  component: CompactEmpty,
});

const compactBotRoute = createRoute({
  getParentRoute: () => compactFrameRoute,
  path: "/$botId",
  validateSearch: conversationSearch,
  loaderDeps: ({ search }) => ({ task: search.task }),
  loader: ({ params, deps }) => prefetchConversation(params.botId, deps.task),
  component: ConversationScreen,
});

/**
 * A pro route exists only when the build carries its console module: solo,
 * `/settings/billing` is not a route at all (the not-found screen answers),
 * never a screen that calls a pro endpoint.
 */
const WITH_BILLING = proConsole().billing !== undefined;
const proRoutes = <R,>(present: boolean, routes: R[]): R[] => (present ? routes : []);

const routeTree = rootRoute.addChildren([
  loginRoute,
  memberInvitationRoute,
  changePasswordRoute,
  legalRoute,
  appFrameRoute.addChildren([
    indexRoute,
    inboxLegacyRoute,
    botLandingRoute,
    chatLandingRedirectRoute,
    botConversationRoute,
    chatSessionRedirectRoute,
    conversationLegacyRoute,
    ...groupRoutes(appFrameRoute),
    ...devRoutes,
  ]),
  decisionsLegacyRoute,
  onboardingRoute,
  compactFrameRoute.addChildren([compactIndexRoute, compactBotRoute]),
  settingsFrameRoute.addChildren([
    settingsIndexRoute, activitySettingsRoute,
    accountSettingsRoute,
    organizationSettingsRedirectRoute,
    runtimeSettingsRoute,
    agentsSettingsRoute,
    modelsSettingsRoute,
    appearanceSettingsRoute,
    ...(["/updates", "/notch"] as const).map((path) => createRoute({ getParentRoute: () => settingsFrameRoute, path, component: SETTINGS_SECTIONS[`/settings${path}`] })), // Tauri app (the notch: on Mac)
    archivesSettingsRoute,
    connectorsSettingsRoute,
    notificationsSettingsRoute,
    inboxSettingsRoute,
    decisionsSettingsRoute,
    policiesSettingsRoute,
    securitySettingsRoute,
    ...proRoutes(WITH_BILLING, [billingSettingsRoute]),
    developerSettingsRoute,
  ]),
]);

/** For the duration of the transition, `data-openedbot-vt` on <html> chooses push or pop (`mobile.css`). */
const VIEW_TRANSITION_RESET_MS = 400;

/**
 * The mobile stack animates through the View Transitions API: and only there: on
 * desktop, between two drawer screens, or under `prefers-reduced-motion`,
 * `false` lets the router replace the screen with no transition.
 */
/**
 * The address-bar path, read from the router's history: a click
 * updates its location at once but pushes the URL only on the
 * next microtask. Read from `window.location`, a link to the public page
 * from `/login` still saw `/login`, took `/` for the internal overview and
 * fell back to `/login`.
 */
function currentAddressPath(fallback: string): string {
  return routerInstance?.history.location.pathname ?? globalThis.location?.pathname ?? fallback;
}

let routerInstance: { history: { location: { pathname: string } } } | undefined;

export const router = createRouter({
  routeTree,
  rewrite: {
    input: ({ url }) => rootRewriteInput(url, currentAddressPath(url.pathname)) ?? workspaceRewriteInput({ url }),
    output: ({ url }) => {
      const organizationId = activeOrganizationId();
      const root = rootRewriteOutput(url.pathname, organizationId);
      if (root) {
        const next = new URL(url);
        next.pathname = root;
        return next;
      }
      if (!organizationId || !isWorkspacePath(url.pathname)) return url;
      const next = new URL(url);
      next.pathname = workspaceHref(organizationId, internalWorkspacePath(url.pathname));
      return next;
    },
  },
  // The equivalent of `error.tsx`: without it, an exception in a screen leaves
  // a blank page, indistinguishable from a load that does not finish.
  defaultErrorComponent: ({ error, reset }) => <AppErrorScreen error={error} reset={reset} />,
  // The counterpart of `error.tsx` for what does not exist: without it, TanStack renders
  // "Not Found" as bare text, in English, with no way out. A stale URL is an
  // ORDINARY state (bookmark, notification, rewritten link), not an anomaly.
  defaultNotFoundComponent: () => <NotFoundScreen />,
  // TanStack waits 1 s before showing a `pendingComponent`, then keeps it
  // 500 ms: a second of blank page at launch, then a silhouette
  // that lingers. 150 ms shows nothing for a guard served from cache,
  // and 200 ms of hold is enough not to flicker.
  defaultPendingMs: 150,
  defaultPendingMinMs: 200,
  defaultViewTransition: {
    types: ({ fromLocation, toLocation }) => {
      if (typeof window === "undefined" || !window.matchMedia("(max-width: 767px)").matches) return false;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      const direction = mobileTransition(fromLocation?.pathname, toLocation.pathname);
      if (direction === null) return false;
      const root = document.documentElement;
      root.setAttribute("data-openedbot-vt", direction);
      window.setTimeout(() => {
        if (root.getAttribute("data-openedbot-vt") === direction) root.removeAttribute("data-openedbot-vt");
      }, VIEW_TRANSITION_RESET_MS);
      return [`openedbot-${direction}`];
    },
  },
});
routerInstance = router;

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
