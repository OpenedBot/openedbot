import type { ComponentType, ReactNode } from "react";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RiArrowLeftLine, RiLogoutBoxRLine, RiShieldLine, RiUserLine } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useOperatorIdentity } from "../../lib/session/operator-identity";
import { signOut } from "../../lib/session/sign-out";
import type { FLEET_OWN_SETTINGS_PATHS } from "../../lib/workspace/workspace-location";
import { FLEET_CLIENT_SETTINGS_GROUPS, FLEET_SETTINGS_GROUPS, isSettingsEntryActive, SETTINGS_GROUPS, useVisibleSettingsGroups } from "../dashboard/settings-sidebar";
import { fleetSectionOf, useFleetFrameContext } from "../../pro-console/slots";
import { forgetSettingsReturn, settingsCloseHref } from "../../lib/shell/settings-return";
import { BOARD_SIDEBAR_CARD } from "./board-sidebar-card";

export { useSettingsModal } from "../../lib/shell/settings-modal-context";

const NAV_ITEM =
  "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 text-start outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring";
type FleetOwnSettingsPath = (typeof FLEET_OWN_SETTINGS_PATHS)[number];
const FLEET_PERSONAL_SETTINGS_PATHS = {
  profile: "/settings/profile",
  security: "/settings/security",
} as const satisfies Record<"profile" | "security", FleetOwnSettingsPath>;

/**
 * Settings as a page of the frame (desktop), without backdrop: the frame's bar
 * carries the section title.
 *
 * A workspace always shows its settings this way since 2026-11-02 (the
 * window is gone, operator decision): the whole frame becomes settings, as in
 * OpenTrack. The sections menu takes the conversations sidebar's place
 * (`SettingsPageSidebar`), the section the full main card.
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
  const content = (
    <div data-settings-page="" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip [&_[data-settings-pane]]:px-3 lg:[&_[data-settings-pane]]:px-4">
      {children}
    </div>
  );
  if (!fleetFrame) return content;
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
  return <SettingsNav pathname={pathname.replace(/^\/o\/[^/]+/, "")} variant="sidebar" header={back} signOut />;
}

/**
 * A workspace's settings as a page: the sections menu in the conversations
 * sidebar's column and card (`BoardFrame` `sidebar`), led by the way out to
 * the screen settings were opened from.
 */
export function SettingsPageSidebar({ signOut = true }: { /** Faux dans la silhouette du cadre, montée avant les fournisseurs de données. */ signOut?: boolean } = {}) {
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
          signOut={signOut}
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

/** La déconnexion (ou la sortie du mode assistance), tout en bas de la navigation des réglages. */
function SettingsSignOut() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const { signedIn, impersonating } = useOperatorIdentity();
  const leaving = useMutation({ mutationFn: () => signOut(queryClient) });
  if (!signedIn) return null;
  const label = t(impersonating ? "navUser.leaveImpersonation" : "navUser.signOut");
  return (
    <button
      type="button"
      disabled={leaving.isPending}
      onClick={() => leaving.mutate()}
      className={cn(NAV_ITEM, "mt-auto shrink-0 hover:bg-background-secondary-hover/60 disabled:opacity-50")}
    >
      <RiLogoutBoxRLine className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <span className="truncate text-body-medium text-text-secondary">{label}</span>
    </button>
  );
}

type SettingsNavGroup = (typeof SETTINGS_GROUPS)[number] | (typeof FLEET_SETTINGS_GROUPS)[number];

/**
 * La navigation des réglages : les rubriques d'openedbot groupées comme dans
 * la barre des réglages, au format du template.
 * Over an agency fleet it lists the agency's own sections instead
 * (`FLEET_SETTINGS_GROUPS`), and « Mon compte » is the profile without members.
 */
function SettingsNav({ pathname, variant, header, groups: groupsOverride, personal = true, signOut = false }: {
  pathname: string;
  /**
   * `sidebar`: full width inside the agency frame's sidebar card. `inline`: a
   * column of the main card, beside the section. Both keep their labels.
   */
  variant: "sidebar" | "inline";
  header?: ReactNode;
  groups?: typeof SETTINGS_GROUPS;
  /** The « Personnel » block (account, sign out). */
  personal?: boolean;
  /** La déconnexion, tout en bas ; montée seulement sous les fournisseurs de données. */
  signOut?: boolean;
}) {
  const { t } = useT();
  const internal = pathname;
  const fleetHome = useFleetFrameContext()?.client === null;
  const groups = useVisibleSettingsGroups<SettingsNavGroup>(groupsOverride ?? (fleetHome ? FLEET_SETTINGS_GROUPS : SETTINGS_GROUPS));
  const Item = ({ to, icon: Icon, label, exact, disabled, also }: { to: string; icon: ComponentType<{ className?: string }>; label: string; exact?: boolean; disabled?: boolean; also?: readonly string[] }) => {
    const active = isSettingsEntryActive(internal, to, exact) || (also ?? []).some((url) => isSettingsEntryActive(internal, url));
    const body = (
      <>
        <Icon className="size-5 shrink-0 text-foreground-icon-secondary" />
        <span className={cn("truncate text-body-medium", active ? "text-text-primary" : "text-text-secondary")}>{label}</span>
      </>
    );
    if (disabled) {
      return <span aria-disabled className={cn(NAV_ITEM, "cursor-not-allowed opacity-50")} title={label}>{body}</span>;
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
              : "bui-scroll flex w-52 shrink-0 flex-col gap-5 overflow-y-auto border-e border-separator-border px-2.5 py-4"}
          >
            {header}
            {groups.map((group) => (
              <div key={group.labelKey} className="flex w-full flex-col gap-1.5 pt-1">
                <span className="ps-2 text-body-medium text-text-secondary">{t(group.labelKey)}</span>
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
              <span className="ps-2 text-body-medium text-text-secondary">{t("boardui.account.personal")}</span>
              <div className="flex w-full flex-col gap-1">
                {fleetHome ? (
                  <>
                    <Item to={FLEET_PERSONAL_SETTINGS_PATHS.profile} icon={RiUserLine} label={t("fleet.myAccount")} />
                    <Item to={FLEET_PERSONAL_SETTINGS_PATHS.security} icon={RiShieldLine} label={t("settingsSidebar.security")} />
                  </>
                ) : (
                  <Item to="/settings/account" icon={RiUserLine} label={t("settingsSidebar.account")} />
                )}
              </div>
            </div> : null}
            {personal && signOut ? <SettingsSignOut /> : null}
          </nav>
  );
}
