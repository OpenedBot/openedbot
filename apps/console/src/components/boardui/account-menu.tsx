import { memo, Suspense, useState, type ComponentType, type ReactNode } from "react";
import {
  RiDashboard3Line,
  RiLogoutBoxRLine,
  RiMoonLine,
  RiPaletteLine,
  RiSettings3Line,
  RiSunLine,
  RiTranslate2,
} from "@remixicon/react";
import { cn, Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@openedbot/browser-ui-kit";
import { useTheme } from "@openedbot/browser-ui-kit/theme";
import { LOCALES } from "@openedbot/contracts-locale";
import { useOperatorIdentity } from "../../lib/session/operator-identity";
import { useOpenSettings } from "../../lib/shell/settings-overlay";
import { useSignOut } from "../../lib/session/sign-out";
import { haptics } from "../../lib/platform/haptics";
import { useT } from "../../lib/i18n";
import { useMobileDrawer } from "../mobile/mobile-drawer-shell";
import { OperatorBlob } from "../operator-blob";
import { percentTone, useProviderLimits } from "../dashboard/provider-limits-panel";
import { BUI_PANEL_ITEM, BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./menu";
import packageJson from "../../../package.json";
import { DesktopUpdateMenuRow, DesktopUpdatePill } from "../desktop-update/entry";

type IconType = ComponentType<{ className?: string }>;

/** The pill at the foot of the bar: the desktop app update. */
const FooterPill = DesktopUpdatePill;

/**
 * The Tauri app update pill, alone at the foot of the bar when
 * the account is elsewhere (layouts « b » and « c »); nothing on the web.
 */
export function AccountUpdatePill() {
  return FooterPill ? <div className="flex justify-end"><Suspense fallback={null}><FooterPill /></Suspense></div> : null;
}

/**
 * A menu row. At module level, not inside `AccountMenu`: a
 * component declared during render is a new type on every render, and React
 * unmounted then remounted every row instead of updating them.
 */
function MenuItem({
  icon: Icon,
  label,
  value,
  onSelect,
  disabled,
  mobileDrawer,
}: {
  icon: IconType;
  label: string;
  /** A grey value on the right, like « 1 % utilisé » in the reference app. */
  value?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  mobileDrawer: boolean;
}) {
  return (
    <button
      type="button"
      data-closes-drawer=""
      disabled={disabled}
      className={cn(BUI_PANEL_ITEM, "gap-2.5 p-2", mobileDrawer && "min-h-11 active:bg-background-primary-hover")}
      onClick={onSelect}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Icon className="size-5 shrink-0 text-foreground-icon-secondary" />
        <span className="truncate text-body-medium text-text-primary">{label}</span>
      </span>
      {value}
    </button>
  );
}

/**
 * The provider quota furthest spent, as a menu row (the reference app:
 * « Utilisation hebdomadaire · 1 % utilisé »). Nothing until some account
 * is measured, nor for a member who does not read quotas. Mounted only
 * with the menu open: the read is the cached one from the composer
 * tab and the bar alert (`useProviderLimits`).
 */
function UsageMenuItem({ mobileDrawer, onSelect }: { mobileDrawer: boolean; onSelect: () => void }) {
  const { t } = useT();
  const limits = useProviderLimits(false);
  const peak = limits.servicePeak ?? limits.peak;
  if (!limits.canView || peak === null) return null;
  const percent = Math.round(peak);
  return (
    <MenuItem
      mobileDrawer={mobileDrawer}
      icon={RiDashboard3Line}
      label={t("navUser.usage")}
      value={
        <span className={cn("shrink-0 text-body-regular tabular-nums", percent > 80 ? percentTone(percent) : "text-text-secondary")}>
          {t("navUser.usageValue", { percent })}
        </span>
      }
      onSelect={onSelect}
    />
  );
}

/**
 * The account at the foot of the bar and its menu. On desktop, a flat row
 * (26 px avatar, handle, address, Settings gear); the menu opens to
 * the right of the bar, aligned to its bottom. In the mobile drawer, the
 * template card (32 px avatar, chevron in a 16 px square). In the mobile shell
 * it is not a popover: a sheet anchored at the bottom (grabber, radius 16,
 * margin under the home indicator), like a native chrome menu.
 *
 * The menu keeps only the minimum, by operator decision: the quota
 * furthest spent (added on 30-10, like the reference app), Settings (which
 * hold profile, archives, members, billing, organization,
 * connectors, notifications, account and decisions), the theme, the
 * language and sign-out. Settings has left the foot of the bar.
 */
type AccountMenuProps = {
  variant?: "footer" | "avatar" | "avatar-name";
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
};

export const AccountMenu = memo(function AccountMenu({
  variant = "footer",
  side = "right",
  align = "end",
}: AccountMenuProps) {
  const { t, locale, setLocale } = useT();
  const openSettings = useOpenSettings();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const mobileDrawer = useMobileDrawer();
  const segment = mobileDrawer ? "size-11" : "size-6";
  const segmentShift = mobileDrawer ? "translate-x-[46px]" : "translate-x-[26px]";
  const { name, email, signedIn, assisted } = useOperatorIdentity();
  const shortName = name.replace(/^@/, "");
  const leaving = useSignOut();

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  // The face lives on the account row, always on screen. In the menu
  // header, open for a few seconds, it is frozen: a second animated face
  // added an engine sample per frame during opening.
  const avatar = (size: string, animated = true) => (
    <span className={cn("inline-flex shrink-0 overflow-hidden rounded-full", size)}>
      <OperatorBlob name={t("navUser.operator")} className="size-full" animated={animated} />
    </span>
  );

  const onMenuOpenChange = (next: boolean) => {
    if (next && mobileDrawer) haptics.light();
    setOpen(next);
  };

  // The mobile drawer card. On desktop, the flat row is further down.
  const trigger = (
          <button
            type="button"
            data-nav-user=""
            aria-label={name}
            className="flex w-full cursor-pointer items-center justify-between overflow-hidden rounded-xl border-2 border-transparent bg-background-tertiary-default py-2 ps-2.5 pe-4 outline-none transition-[width,background-color,border-color,padding] duration-300 ease-in-out hover:border-border-button-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring focus-visible:ring-offset-2 active:bg-background-tertiary-hover"
          >
            <span className="flex min-w-0 items-center gap-2">
              {avatar("size-8")}
              <span className="flex min-w-0 flex-col items-start justify-center">
                <span className="max-w-40 truncate text-body-medium text-text-primary">{name}</span>
                <span className="max-w-40 truncate text-body-regular text-text-secondary">
                  {assisted ? t("navUser.assistanceReadOnly") : email}
                </span>
              </span>
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-background-tertiary-hover">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden className={cn("size-4 text-text-secondary transition-transform duration-200", open && "rotate-180")}>
                <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
  );

  const panel = (
    <>
          <div className="flex w-full items-center gap-2 px-2 pt-1">
            {avatar("size-8", false)}
            <div className="flex min-w-0 flex-col items-start justify-center">
              <span className="max-w-[180px] truncate text-body-medium text-text-primary">{name}</span>
              <span className="max-w-[180px] truncate text-body-regular text-text-secondary">{email}</span>
            </div>
          </div>
          <div className="flex w-full flex-col gap-1">
            {DesktopUpdateMenuRow ? <Suspense fallback={null}><DesktopUpdateMenuRow mobileDrawer={mobileDrawer !== null} onSelect={() => setOpen(false)} /></Suspense> : null}
            <UsageMenuItem mobileDrawer={mobileDrawer !== null} onSelect={() => run(() => openSettings("/settings/models"))} />
            <MenuItem mobileDrawer={mobileDrawer !== null} icon={RiSettings3Line} label={t("navUser.settings")} onSelect={() => run(() => openSettings())} />
          </div>
          <div className="-mx-1.5 my-1 h-px bg-border-button-default" />
          <div className="flex w-full flex-col gap-1">
            <div className={cn("flex w-full items-center justify-between gap-2.5 rounded-2lg px-2 py-1", mobileDrawer && "min-h-11")}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <RiPaletteLine className="size-5 shrink-0 text-foreground-icon-secondary" />
                <span className="truncate text-body-medium text-text-primary">{t("boardui.account.appearance")}</span>
              </span>
              <div role="group" aria-label={t("boardui.account.theme")} className="relative inline-flex w-fit shrink-0 items-center gap-0.5 rounded-full bg-background-secondary-default p-0.5">
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute start-0.5 top-0.5 rounded-full bg-background-primary-default shadow-xs transition-transform duration-200",
                    segment,
                    theme.resolved === "dark" && segmentShift,
                  )}
                />
                <button
                  type="button"
                  aria-label={t("navUser.lightTheme")}
                  aria-pressed={theme.resolved !== "dark"}
                  title={t("navUser.lightTheme")}
                  onClick={() => theme.setMode("light")}
                  className={cn(
                    "relative z-10 grid cursor-pointer place-items-center rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    segment,
                    theme.resolved !== "dark" ? "text-foreground-icon-primary" : "text-foreground-icon-secondary hover:text-foreground-icon-primary",
                  )}
                >
                  <RiSunLine className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t("navUser.darkTheme")}
                  aria-pressed={theme.resolved === "dark"}
                  title={t("navUser.darkTheme")}
                  onClick={() => theme.setMode("dark")}
                  className={cn(
                    "relative z-10 grid cursor-pointer place-items-center rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    segment,
                    theme.resolved === "dark" ? "text-foreground-icon-primary" : "text-foreground-icon-secondary hover:text-foreground-icon-primary",
                  )}
                >
                  <RiMoonLine className="size-3.5" />
                </button>
              </div>
            </div>
            <div className={cn("flex w-full items-center justify-between gap-2.5 rounded-2lg px-2 py-1", mobileDrawer && "min-h-11")}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <RiTranslate2 className="size-5 shrink-0 text-foreground-icon-secondary" />
                <span className="truncate text-body-medium text-text-primary">{t("settings.appearance.languageTitle")}</span>
              </span>
              <div role="group" aria-label={t("settings.appearance.languageTitle")} className="relative inline-flex w-fit shrink-0 items-center gap-0.5 rounded-full bg-background-secondary-default p-0.5">
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute start-0.5 top-0.5 rounded-full bg-background-primary-default shadow-xs transition-transform duration-200",
                    segment,
                    locale === "en" && segmentShift,
                  )}
                />
                {LOCALES.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    lang={candidate}
                    aria-label={t(candidate === "fr" ? "settings.appearance.languageFr" : "settings.appearance.languageEn")}
                    aria-pressed={locale === candidate}
                    title={t(candidate === "fr" ? "settings.appearance.languageFr" : "settings.appearance.languageEn")}
                    onClick={() => setLocale(candidate)}
                    className={cn(
                      "relative z-10 grid cursor-pointer place-items-center rounded-full text-[11px] leading-none font-medium uppercase outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                      segment,
                      locale === candidate ? "text-text-primary" : "text-text-tertiary hover:text-text-primary",
                    )}
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {signedIn ? (
            <>
              <div className="-mx-1.5 my-1 h-px bg-border-button-default" />
              <MenuItem
                mobileDrawer={mobileDrawer !== null}
                icon={RiLogoutBoxRLine}
                label={t(assisted ? "navUser.leaveAssistance" : "navUser.signOut")}
                disabled={leaving.isPending}
                onSelect={() => leaving.mutate()}
              />
            </>
          ) : null}
          <div className="flex w-full items-center justify-between px-2 pt-1 pb-2">
            <span className="text-body-2-medium whitespace-nowrap text-text-tertiary">openedbot</span>
            <span className="inline-flex items-center justify-center rounded-sm bg-background-tertiary-default px-1 py-px text-body-2-medium whitespace-nowrap text-text-tertiary">
              v{packageJson.version}
            </span>
          </div>
    </>
  );

  if (mobileDrawer) {
    return (
      <Drawer open={open} onOpenChange={onMenuOpenChange} shouldScaleBackground={false}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent
          aria-label={t("boardui.accountMenu", { name })}
          className="border-0 bg-background-primary-default px-3 pb-[max(0.75rem,var(--openedbot-safe-bottom))] text-text-primary"
          style={{ borderTopLeftRadius: 16, borderTopRightRadius: 16 }}
        >
          <DrawerTitle className="sr-only">{t("boardui.accountMenu", { name })}</DrawerTitle>
          {panel}
        </DrawerContent>
      </Drawer>
    );
  }

  // Desktop: a flat row on the frame background, like the mockup
  // (`mockups/header.html`, `.me`): face, handle, address, then the gear
  // that opens Settings in one click. The row opens the account menu. The
  // hover covers the whole row, gear included: to the eye it is one block.
  if (variant === "avatar") {
    return (
      <BuiPopover open={open} onOpenChange={setOpen}>
        <BuiPopoverTrigger asChild>
          <button
            type="button"
            data-nav-user=""
            aria-label={t("boardui.accountMenu", { name })}
            className={cn(
              "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors hover:bg-board-row-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              "size-9",
            )}
          >
            {avatar("size-7")}
          </button>
        </BuiPopoverTrigger>
        <BuiPopoverContent side={side} align={align} sideOffset={6} className="w-[243px] gap-[7px]" aria-label={t("boardui.accountMenu", { name })}>
          {panel}
        </BuiPopoverContent>
      </BuiPopover>
    );
  }

  if (variant === "avatar-name") {
    return (
      <BuiPopover open={open} onOpenChange={setOpen}>
        <BuiPopoverTrigger asChild>
          <button
            type="button"
            data-nav-user=""
            aria-label={t("boardui.accountMenu", { name })}
            className="flex h-9 max-w-[104px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 text-start outline-none transition-colors hover:bg-board-row-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            {avatar("size-7")}
            <span className="max-w-[48px] truncate text-[13px] leading-[18px] font-semibold text-text-primary">{shortName}</span>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden className={cn("size-3.5 shrink-0 text-text-secondary transition-transform duration-200", open && "rotate-180")}>
              <path d="M4.5 6L8 9.5L11.5 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </BuiPopoverTrigger>
        <BuiPopoverContent side={side} align={align} sideOffset={6} className="w-[243px] gap-[7px]" aria-label={t("boardui.accountMenu", { name })}>
          {panel}
        </BuiPopoverContent>
      </BuiPopover>
    );
  }

  return (
    <div className="flex items-center gap-1 rounded-[10px] pe-1 transition-colors hover:bg-board-row-hover">
      <BuiPopover open={open} onOpenChange={setOpen}>
        <BuiPopoverTrigger asChild>
          <button
            type="button"
            data-nav-user=""
            aria-label={name}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-[10px] py-2 ps-2.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
          >
            {avatar("size-[26px]")}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] leading-[18px] font-semibold text-text-primary">{name}</span>
              <span className="truncate text-[12px] leading-4 text-text-secondary">
                {assisted ? t("navUser.assistanceReadOnly") : email}
              </span>
            </span>
          </button>
        </BuiPopoverTrigger>
        <BuiPopoverContent side={side} align={align} sideOffset={8} className="w-[243px] gap-[7px]" aria-label={t("boardui.accountMenu", { name })}>
          {panel}
        </BuiPopoverContent>
      </BuiPopover>
      {/* Tauri app: the « Mettre à jour » pill, next to the account (the reference app). */}
      {FooterPill ? <Suspense fallback={null}><FooterPill /></Suspense> : null}
      <button
        type="button"
        aria-label={t("navUser.settings")}
        title={t("navUser.settings")}
        onClick={() => openSettings()}
        className="inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary outline-none transition-colors hover:bg-board-row-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiSettings3Line className="size-4" aria-hidden />
      </button>
    </div>
  );
});
