import { useEffect, type ComponentType, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RiArrowLeftLine, RiLogoutBoxRLine, RiShieldLine, RiUserLine } from "@remixicon/react";
import { IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import { cn } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { signOut } from "../../lib/sign-out";
import { useT } from "../../lib/i18n";
import type { FLEET_OWN_SETTINGS_PATHS } from "../../lib/workspace-location";
import { FLEET_CLIENT_SETTINGS_GROUPS, FLEET_SETTINGS_GROUPS, isSettingsEntryActive, SETTINGS_GROUPS, useVisibleSettingsGroups } from "../dashboard/settings-sidebar";
import { fleetSectionOf, useFleetFrameContext } from "../../pro-console/slots";
import { BuiCloseGlyph } from "./menu";
import { isOverlaySettingsPath, useSettingsOverlay } from "../../lib/settings-overlay";
import { forgetSettingsReturn, settingsCloseHref } from "../../lib/settings-return";
import { textZoom, useTextSize } from "../../lib/text-size";
import { SettingsModalContext, SettingsPageContext, useSettingsModal, useSettingsPage } from "../../lib/settings-modal-context";
import { queueSettingsOverlay, setSettingsDisplay } from "../../lib/settings-display";
import { BOARD_SIDEBAR_CARD } from "./board-sidebar-card";

export { useSettingsModal } from "../../lib/settings-modal-context";

const NAV_ITEM =
  "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 text-start outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring";
type FleetOwnSettingsPath = (typeof FLEET_OWN_SETTINGS_PATHS)[number];
const FLEET_PERSONAL_SETTINGS_PATHS = {
  profile: "/settings/profile",
  security: "/settings/security",
} as const satisfies Record<"profile" | "security", FleetOwnSettingsPath>;

/**
 * Les réglages, en modale centrée qui suit la fenêtre : 90 % de la largeur et 88 % de la
 * hauteur, plafonnés à 1280 × 900 (au-delà, les champs s'étiraient sans rien gagner) et
 * jamais à moins de 16 px des bords. Rayon 24, navigation de 240 px à gauche (rubriques
 * d'openedbot, réduite aux icônes en fenêtre étroite), la rubrique ouverte à droite. L'URL reste celle de la rubrique (`/settings/...`) : le lien se
 * partage, Retour fonctionne, et la croix ramène au dernier écran.
 */
export function SettingsModal({ children, path, onClose }: {
  children: ReactNode;
  /** Ouverte en surcouche : la rubrique ne se lit pas dans l'emplacement, resté celui de l'app. */
  path?: string;
  onClose?: () => void;
}) {
  const { t } = useT();
  const textSize = useTextSize();
  const { pathname } = useLocation();
  const internal = path ?? pathname.replace(/^\/o\/[^/]+/, "");
  const router = useRouter();
  const navigate = useNavigate();
  // A public address: `navigate({ to })` would run it through the output
  // rewrite, which prefixes the current frame (`/clients/<client>/fleet`).
  const close = onClose ?? (() => {
    const href = settingsCloseHref();
    forgetSettingsReturn();
    router.history.push(href);
  });
  // En page : ouverte en surcouche, la rubrique quitte l'écran courant pour sa
  // route (la croix de la page y ramènera, `rememberAppPath`) ; ouverte comme
  // route, le cadre se redessine seul en page.
  const openAsPage = () => {
    setSettingsDisplay("page");
    if (path) void navigate({ to: internal });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[data-radix-popper-content-wrapper], [role=dialog][data-state=open]:not([data-settings-modal])")) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Taille du texte (Apparence), dans un navigateur : la coque native zoome
  // toute la fenêtre, et `settings-density.css` ignore alors cette variable.
  // Posée sur la racine, pas sur la boîte, pour que les menus et fenêtres
  // ouverts depuis la modale (rendus en portail sous `body`) prennent le même
  // zoom.
  const zoom = textZoom(textSize);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--ohb-settings-zoom", String(zoom));
    return () => {
      root.style.removeProperty("--ohb-settings-zoom");
    };
  }, [zoom]);

  return (
    <SettingsModalContext.Provider value={{ close, openAsPage }}>
      <div data-settings-backdrop="" className="fixed inset-0 z-50 bg-black/50 motion-safe:animate-in motion-safe:fade-in" aria-hidden onClick={close} />
      {/* Coque macOS : la bande des feux tricolores au-dessus de la modale, poignée de la fenêtre. */}
      <div data-settings-drag-strip="" data-titlebar-drag="" aria-hidden />
      <div data-settings-modal-frame="" className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("navUser.settings")}
          data-settings-modal=""
          className="bui-popover pointer-events-auto relative flex h-[min(900px,88dvh)] max-h-[calc(100dvh-32px)] w-[min(1280px,90vw)] max-w-[calc(100vw-32px)] overflow-clip rounded-3xl bg-background-full text-text-primary shadow-xs outline-none"
        >
          <SettingsNav pathname={internal} />
          <div className="flex min-w-0 flex-1 flex-col [&_[data-settings-pane]]:px-3 lg:[&_[data-settings-pane]]:px-4">{children}</div>
        </div>
      </div>
    </SettingsModalContext.Provider>
  );
}

/**
 * Settings as a page of the frame (desktop), without backdrop: the frame's bar
 * carries the section title.
 *
 * A workspace shows it when the operator chose « Page » (Appearance): the
 * whole frame becomes settings, as in OpenTrack. The sections menu takes the
 * conversations sidebar's place (`SettingsPageSidebar`), the section the full
 * main card, and the bar carries the way back to the window
 * (`SettingsPageContext`).
 *
 * The agency's own settings put their navigation in the frame's sidebar
 * (`SettingsSidebarNav`). A client keeps the fleet in the sidebar, since its
 * sections are the client tabs: only the Settings tab gets a navigation, inside
 * the main card, without the sections that are tabs already.
 */
export function SettingsPage({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const internal = pathname.replace(/^\/o\/[^/]+/, "");
  const fleetFrame = useFleetFrameContext();
  const client = fleetFrame?.client ?? null;
  const router = useRouter();
  const content = (
    <div data-settings-page="" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip [&_[data-settings-pane]]:px-3 lg:[&_[data-settings-pane]]:px-4">
      {children}
    </div>
  );
  if (!fleetFrame) {
    // Back to the window: the screen settings were opened from, with the same
    // section above it (`SettingsOverlayHost` takes the queued section).
    const openAsWindow = () => {
      setSettingsDisplay("modal");
      if (!isOverlaySettingsPath(internal)) return;
      queueSettingsOverlay(internal);
      const href = settingsCloseHref();
      forgetSettingsReturn();
      router.history.push(href);
    };
    return <SettingsPageContext.Provider value={{ openAsWindow }}>{content}</SettingsPageContext.Provider>;
  }
  if (!client || fleetSectionOf(internal) !== "/settings") return content;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SettingsNav pathname={internal} variant="inline" groups={FLEET_CLIENT_SETTINGS_GROUPS} personal={false} />
      {content}
    </div>
  );
}

/**
 * The settings navigation in place of the agency frame's sidebar, as in
 * OpenTrack: entering settings swaps the fleet list for the sections, and the
 * link on top (`back`) leaves them.
 */
export function SettingsSidebarNav({ back }: { back: ReactNode }) {
  const { pathname } = useLocation();
  return <SettingsNav pathname={pathname.replace(/^\/o\/[^/]+/, "")} variant="sidebar" header={back} />;
}

/**
 * A workspace's settings as a page: the sections menu in the conversations
 * sidebar's column and card (`BoardFrame` `sidebar`), led by the way out to
 * the screen settings were opened from.
 */
export function SettingsPageSidebar() {
  const { t } = useT();
  const { pathname } = useLocation();
  const router = useRouter();
  const leave = () => {
    const href = settingsCloseHref();
    forgetSettingsReturn();
    router.history.push(href);
  };
  return (
    <aside aria-label={t("navUser.settings")} className="isolate flex h-full min-h-0 w-[272px] shrink-0 flex-col ps-3 pb-3 text-text-primary">
      <div className={BOARD_SIDEBAR_CARD}>
        <SettingsNav
          pathname={pathname.replace(/^\/o\/[^/]+/, "")}
          variant="sidebar"
          header={(
            <button type="button" onClick={leave} className={cn(NAV_ITEM, "hover:bg-background-secondary-hover/60")}>
              <RiArrowLeftLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <span className="truncate text-body-medium text-text-secondary">{t("settingsSidebar.leaveSettings")}</span>
            </button>
          )}
        />
      </div>
    </aside>
  );
}

type SettingsNavGroup = (typeof SETTINGS_GROUPS)[number] | (typeof FLEET_SETTINGS_GROUPS)[number];

/**
 * La navigation de la modale des réglages : les rubriques d'openedbot
 * groupées comme dans la barre des réglages, au format du template.
 * Over an agency fleet it lists the agency's own sections instead
 * (`FLEET_SETTINGS_GROUPS`), and « Mon compte » is the profile without members.
 */
function SettingsNav({ pathname, variant = "modal", header, groups: groupsOverride, personal = true }: {
  pathname: string;
  /**
   * `sidebar`: full width inside the agency frame's sidebar card. `inline`: a
   * column of the main card, beside the section. Both keep their labels.
   */
  variant?: "modal" | "sidebar" | "inline";
  header?: ReactNode;
  groups?: typeof SETTINGS_GROUPS;
  /** The « Personnel » block (account, sign out). */
  personal?: boolean;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  // Le cadre a déjà lu la session : relire au montage de la modale faisait
  // re-rendre tout le cadre au retour, pendant l'animation d'ouverture.
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe, refetchOnMount: false });
  const leaving = useMutation({ mutationFn: () => signOut(queryClient) });
  const internal = pathname;
  const overlay = useSettingsOverlay();
  const router = useRouter();
  const fleetHome = useFleetFrameContext()?.client === null;
  const groups = useVisibleSettingsGroups<SettingsNavGroup>(groupsOverride ?? (fleetHome ? FLEET_SETTINGS_GROUPS : SETTINGS_GROUPS));
  // The modal narrows to icons in a small window; the frame's sidebar keeps its width.
  const shown = variant === "modal" ? "hidden sm:block" : "block";
  const Item = ({ to, icon: Icon, label, exact, disabled, also }: { to: string; icon: ComponentType<{ className?: string }>; label: string; exact?: boolean; disabled?: boolean; also?: readonly string[] }) => {
    const active = isSettingsEntryActive(internal, to, exact) || (also ?? []).some((url) => isSettingsEntryActive(internal, url));
    const body = (
      <>
        <Icon className="size-5 shrink-0 text-foreground-icon-secondary" />
        <span className={cn(shown, "truncate text-body-medium", active ? "text-text-primary" : "text-text-secondary")}>{label}</span>
      </>
    );
    if (disabled) {
      return <span aria-disabled className={cn(NAV_ITEM, "cursor-not-allowed opacity-50")} title={label}>{body}</span>;
    }
    // En surcouche, la rubrique suivante reste en surcouche : l'écran
    // d'origine ne bouge pas. Un `<a>` et pas un `Link` vers « . » : TanStack
    // marquerait chaque lien `aria-current="page"`. Le `href` reste la vraie
    // URL de la rubrique, pour Ctrl+clic et le partage.
    if (overlay && isOverlaySettingsPath(to)) {
      return (
        <a
          href={router.buildLocation({ to }).publicHref}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            overlay.open(to);
          }}
          aria-label={label}
          title={label}
          aria-current={active ? "page" : undefined}
          className={cn(NAV_ITEM, active ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover/60")}
        >
          {body}
        </a>
      );
    }
    return (
      <Link
        to={to}
        activeOptions={{ exact: exact ?? false }}
        aria-label={label}
        title={label}
        aria-current={active ? "page" : undefined}
        className={cn(NAV_ITEM, active ? "bg-background-secondary-hover" : "hover:bg-background-secondary-hover/60")}
      >
        {body}
      </Link>
    );
  };

  return (
          <nav
            aria-label={t("boardui.settingsSections")}
            data-settings-nav={variant}
            className={variant === "sidebar"
              ? "bui-scroll flex min-h-0 w-full flex-1 flex-col gap-5 overflow-y-auto"
              : variant === "inline"
                ? "bui-scroll flex w-52 shrink-0 flex-col gap-5 overflow-y-auto border-e border-separator-border px-2.5 py-4"
                : "bui-scroll flex w-14 shrink-0 flex-col gap-5 overflow-y-auto border-e border-separator-border bg-background-secondary-default p-2.5 sm:w-48 lg:w-60"}
          >
            {header}
            {groups.map((group) => (
              <div key={group.labelKey} className="flex w-full flex-col gap-1.5 pt-1">
                <span className={cn(shown, "ps-2 text-body-medium text-text-secondary")}>{t(group.labelKey)}</span>
                <div className="flex w-full flex-col gap-1">
                  {group.items.map((item) => (
                    <Item
                      key={item.url}
                      to={item.url}
                      icon={item.icon}
                      label={t(item.titleKey)}
                      exact={item.exact}
                      disabled={item.disabled}
                      also={"also" in item ? item.also : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
            {/* A workspace lists « Mon compte » in « Moi » and signs out from
                that page; the agency's home keeps its personal block. */}
            {personal && fleetHome ? <div className="flex w-full flex-col gap-1.5 pt-1">
              <span className={cn(shown, "ps-2 text-body-medium text-text-secondary")}>{t("boardui.account.personal")}</span>
              <div className="flex w-full flex-col gap-1">
                {fleetHome ? (
                  <>
                    <Item to={FLEET_PERSONAL_SETTINGS_PATHS.profile} icon={RiUserLine} label={t("fleet.myAccount")} />
                    <Item to={FLEET_PERSONAL_SETTINGS_PATHS.security} icon={RiShieldLine} label={t("settingsSidebar.security")} />
                  </>
                ) : (
                  <Item to="/settings/account" icon={RiUserLine} label={t("settingsSidebar.account")} />
                )}
                {/* In the agency frame the top bar already signs out. */}
                {variant === "modal" && me.data?.kind === "session" ? (
                  <button
                    type="button"
                    disabled={leaving.isPending}
                    onClick={() => leaving.mutate()}
                    className={cn(NAV_ITEM, "hover:bg-background-secondary-hover/60 disabled:opacity-50")}
                    title={t("settingsSidebar.signOut")}
                  >
                    <RiLogoutBoxRLine className="size-5 shrink-0 text-foreground-icon-secondary" />
                    <span className={cn(shown, "truncate text-body-medium text-text-secondary")}>
                      {leaving.isPending ? t("settingsSidebar.signingOut") : t("settingsSidebar.signOut")}
                    </span>
                  </button>
                ) : null}
              </div>
            </div> : null}
          </nav>
  );
}

const ROUND_ACTION =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary outline-none transition-colors duration-150 hover:bg-background-tertiary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring";

/** L'en-tête d'une rubrique dans la modale : titre de 20 px, passage en page et croix ronde. */
export function SettingsModalHeader({ title }: { title: ReactNode }) {
  const { t } = useT();
  const modal = useSettingsModal();
  return (
    <div data-titlebar-drag="" className="flex shrink-0 items-center justify-between gap-2 px-3 pt-5 pb-3 lg:px-4 lg:pt-8">
      <h1 className="min-w-0 truncate text-[20px] leading-[26px] font-medium text-text-primary">{title}</h1>
      <div className="flex shrink-0 items-center gap-2">
      {modal?.openAsPage ? (
        <button
          type="button"
          aria-label={t("settingsSidebar.openAsPage")}
          title={t("settingsSidebar.openAsPage")}
          onClick={modal.openAsPage}
          className={ROUND_ACTION}
        >
          <IconArrowsMaximize className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t("boardui.closeSettings")}
        onClick={modal?.close}
        className={ROUND_ACTION}
      >
        <BuiCloseGlyph />
      </button>
      </div>
    </div>
  );
}

/** Dans la barre du cadre, quand les réglages sont en page : le retour en fenêtre. */
export function SettingsOpenAsWindowButton() {
  const { t } = useT();
  const page = useSettingsPage();
  if (!page) return null;
  return (
    <button
      type="button"
      aria-label={t("settingsSidebar.openAsWindow")}
      title={t("settingsSidebar.openAsWindow")}
      onClick={page.openAsWindow}
      className={ROUND_ACTION}
    >
      <IconArrowsMinimize className="size-3.5" aria-hidden />
    </button>
  );
}
