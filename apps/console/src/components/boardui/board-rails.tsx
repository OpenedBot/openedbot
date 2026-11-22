import { Suspense, type ReactNode } from "react";
import { RiSettings3Line } from "@remixicon/react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { useOpenSettings } from "../../lib/shell/settings-overlay";
import { useRuntimeHealth } from "../../lib/runtime/use-runtime-health";
import packageJson from "../../../package.json";
import { RailModelsPill } from "./rail-llm-quotas";
import { RailConnectorsPill } from "./rail-connectors-pill";
import { DesktopUpdateRailButton } from "../desktop-update/entry";
import { SidebarToggle } from "./board-chrome";

/**
 * Variant C (`lib/shell/account-layout.ts`, chosen in Settings > Appearance), desktop only: the reference app
 * shell, in the console as on the desktop. No icon rail any more: the
 * conversations card carries it, on two rows. At its head, after the logo (web)
 * or the macOS traffic lights, search and the « + »; at its
 * foot, one row: the « Modèles » pill (LLM quota left at GPT, Anthropic,
 * Grok, and the runtime), the « Connecteurs » pill, then Settings (`RailFooter`). No avatar:
 * theme and language are set in Settings > Appearance, no longer in the rail
 * (decision of 04-11-2026).
 */

/** A vertical hairline between two groups of the foot row. */
export const RAIL_DIVIDER = "mx-0.5 h-5 w-px shrink-0 bg-border-button-default";

/** 36 px, 18 px icon. */
export const RAIL_BUTTON =
  "relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary outline-none transition-colors duration-150 hover:bg-board-row-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring aria-[current=page]:bg-background-tertiary-default aria-[current=page]:text-foreground-icon-primary motion-reduce:transition-none [&>svg]:size-[18px]";

function RailTip({ label, side, children }: { label: string; side: "top" | "bottom"; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The start of the conversations card's head row: the openedbot logo on the
 * web, the room kept for the macOS traffic lights in the desktop app
 * (`native-titlebar.css`). Search and the « + » follow it (`BoardSidebar`).
 */
export function RailLogo() {
  return (
    <>
      <span aria-hidden data-titlebar-lights="" />
      <img data-rail-logo="" src="/brand/openedbot-icon.webp" alt={`openedbot v${packageJson.version}`} title={`openedbot v${packageJson.version}`} className="ms-1 size-7 shrink-0 object-contain" />
    </>
  );
}

/**
 * The main card's header lead, just left of the breadcrumb: the collapse
 * (since 09-11-2026). With the conversations card collapsed, the card's start
 * (logo or traffic lights' room) comes along, at the card's head-row height,
 * where the shell keeps the lights (`set_titlebar_anchor` « card »).
 */
export function RailLead({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      data-rail-lead=""
      data-rail-head={collapsed ? "" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-1.5",
        // The header row lines up with the card's head row (8 px under the
        // card top); collapsed, the card's start comes along from 8 px in.
        "h-9",
        collapsed && "-ms-1",
      )}
    >
      {collapsed ? <RailLogo /> : null}
      <SidebarToggle className={RAIL_BUTTON} />
    </div>
  );
}

/**
 * The foot of the conversations card, one row: the « Modèles » pill (LLM
 * quotas and runtime) on the left; on the right the « Connecteurs » pill,
 * then past a hairline the desktop update when one is ready and Settings.
 */
export function RailFooter() {
  const { t } = useT();
  const openSettings = useOpenSettings();
  // Same read as the top bar badge on a thread: one `GET /api/runtime` entry.
  const runtimeHealth = useRuntimeHealth();

  return (
    <nav data-rail-footer="" aria-label={t("boardui.accountMenu", { name: t("navUser.operator") })} className="flex shrink-0 items-center gap-1">
      <RailModelsPill runtime={runtimeHealth} onOpenSettings={openSettings} />
      {/* Right-aligned: either pill changing width on load moves nothing but free room. */}
      <div className="ms-auto flex shrink-0 items-center gap-1">
        <RailConnectorsPill onOpenSettings={openSettings} />
        <div aria-hidden className={RAIL_DIVIDER} />
        {/* Desktop app: the update ready, just before Settings (nothing on the web). */}
        {DesktopUpdateRailButton ? <Suspense fallback={null}><DesktopUpdateRailButton /></Suspense> : null}
        <RailTip label={t("navUser.settings")} side="top">
          <button type="button" aria-label={t("navUser.settings")} className={RAIL_BUTTON} onClick={() => openSettings()}>
            <RiSettings3Line aria-hidden />
          </button>
        </RailTip>
      </div>
    </nav>
  );
}
