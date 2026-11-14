import type { ComponentType, ReactNode } from "react";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { RiArrowLeftLine, RiLogoutBoxRLine } from "@remixicon/react";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useOperatorIdentity } from "../../lib/session/operator-identity";
import { useSignOut } from "../../lib/session/sign-out";
import { isSettingsEntryActive, SETTINGS_GROUPS, useVisibleSettingsGroups } from "../dashboard/settings-sidebar";
import { forgetSettingsReturn, settingsCloseHref } from "../../lib/shell/settings-return";
import { useAccountLayout } from "../../lib/shell/account-layout";
import { BOARD_SIDEBAR_CARD } from "./board-sidebar-card";

export { useSettingsModal } from "../../lib/shell/settings-modal-context";

const NAV_ITEM =
  "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 text-start outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring";

/**
 * Settings as a page of the frame (desktop), without backdrop: the frame's bar
 * carries the section title.
 *
 * A workspace always shows its settings this way since 2026-11-02 (the
 * window is gone, operator decision): the whole frame becomes settings, as in
 * OpenTrack. The sections menu takes the conversations sidebar's place
 * (`SettingsPageSidebar`), the section the full main card.
 */
export function SettingsPage({ children }: { children: ReactNode }) {
  return (
    <div data-settings-page="" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip [&_[data-settings-pane]]:px-3 lg:[&_[data-settings-pane]]:px-4">
      {children}
    </div>
  );
}

/**
 * A workspace's settings as a page: the sections menu in the conversations
 * sidebar's column and card (`BoardFrame` `sidebar`), led by the way out to
 * the screen settings were opened from.
 */
export function SettingsPageSidebar({ signOut = true }: { /** False in the frame's silhouette, mounted before the data providers. */ signOut?: boolean } = {}) {
  const { t } = useT();
  const { pathname } = useLocation();
  const router = useRouter();
  // Rail shell: the macOS app puts its traffic lights in this card's head
  // row (`BoardFrame`, anchor « card »). An empty row takes them, the way out
  // comes under it; `native-titlebar.css` shows the row in the macOS app only.
  const lightsRow = useAccountLayout() === "c";
  const leave = () => {
    const href = settingsCloseHref();
    forgetSettingsReturn();
    router.history.push(href);
  };
  return (
    <aside aria-label={t("navUser.settings")} className="isolate flex h-full min-h-0 w-[272px] shrink-0 flex-col ps-3 pb-3 text-text-primary">
      <div className={BOARD_SIDEBAR_CARD}>
        {/* Out of the scrolling list: the lights do not scroll. */}
        {lightsRow ? <div aria-hidden data-settings-lights-row="" data-titlebar-drag="" className="mb-1.5 h-9 shrink-0" /> : null}
        <SettingsNav
          pathname={pathname.replace(/^\/o\/[^/]+/, "")}
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

/** Sign-out (or leaving assistance mode), at the very bottom of the settings navigation. */
function SettingsSignOut() {
  const { t } = useT();
  const { signedIn, assisted } = useOperatorIdentity();
  const leaving = useSignOut();
  if (!signedIn) return null;
  const label = t(assisted ? "navUser.leaveAssistance" : "navUser.signOut");
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

/**
 * The settings navigation: openedbot's sections grouped as in
 * the settings bar, in the template's format, full width inside the
 * settings sidebar card.
 */
function SettingsNav({ pathname, header, signOut = false }: {
  pathname: string;
  header?: ReactNode;
  /** Sign-out, at the very bottom; mounted only under the data providers. */
  signOut?: boolean;
}) {
  const { t } = useT();
  const internal = pathname;
  const groups = useVisibleSettingsGroups(SETTINGS_GROUPS);
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
            data-settings-nav="sidebar"
            className="bui-scroll flex min-h-0 w-full flex-1 flex-col gap-5 overflow-y-auto"
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
            {signOut ? <SettingsSignOut /> : null}
          </nav>
  );
}
