import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { RiAddFill, RiArrowLeftSLine, RiArrowRightSLine, RiSearchLine, RiSideBarLine } from "@remixicon/react";
import type { BotDto } from "@openedbot/contracts-api";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { shortcutLabel } from "../../lib/shell/shortcut-label";
import { useT } from "../../lib/i18n";
import { BotFace } from "../bot-face";
import { DeployEnvironmentBadge } from "../deploy-environment-badge";
import { BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./menu";

/**
 * The desktop frame's top bar, in the manner of Codex or the reference app:
 * a single 46 px row across the full width, above the
 * sidebar and the main card, on the frame background.
 *
 * - above the sidebar: the organization and the collapse (`Ctrl B`);
 * - above the card: Back / Forward, then the header of the screen
 *   on display (breadcrumb and actions), which each screen places there by portal
 *   (`BoardHeader`) without the frame knowing it.
 *
 * Bar collapsed, its first row (search, Store, « + ») moves up into
 * this bar: nothing disappears with it.
 */

const COLLAPSED_KEY = "openedbot:sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** What the sidebar must do when it was asked for from elsewhere. */
export type BoardChromeRequest = { kind: "search" | "createBot" | "createGroup"; at: number };

type BoardChromeState = {
  collapsed: boolean;
  toggle: () => void;
  /** The sidebar reads the latest request and runs it once (`at`). */
  request: BoardChromeRequest | null;
  ask: (kind: BoardChromeRequest["kind"]) => void;
};

export const useBoardChrome = create<BoardChromeState>()((set, get) => ({
  collapsed: readCollapsed(),
  toggle: () => {
    const collapsed = !get().collapsed;
    try {
      globalThis.localStorage?.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Private browsing: the collapse lasts for the session only.
    }
    set({ collapsed });
  },
  request: null,
  // Search lives in the bar: asking for it reopens the bar first.
  ask: (kind) => {
    if (kind === "search" && get().collapsed) get().toggle();
    set({ request: { kind, at: Date.now() } });
  },
}));

/** The screen-header slot in the top bar, `null` outside the frame. */
const BoardHeaderSlotContext = createContext<HTMLElement | null>(null);
export const BoardHeaderSlotProvider = BoardHeaderSlotContext.Provider;

/** The top bar's round 30 px buttons. */
export const BAR_ICON_BUTTON =
  "inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary outline-none transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:pointer-events-none disabled:opacity-35";

/** The sidebar's collapsible column (`BoardFrame`), the target of `aria-controls`. */
export const BOARD_SIDEBAR_ID = "openedbot-board-sidebar";

/**
 * The collapse transitions, those of the Dashboard bar on boardui.com:
 * 300 ms, `ease-in-out`, everything starts together, with no delay.
 */
export const COLLAPSE_MOTION = "duration-300 ease-in-out motion-reduce:transition-none";

/**
 * The bloub just after the macOS traffic lights, before the bar collapse: the
 * lights cover the rail logo, so it shows here instead
 * (`native-titlebar.css`). Hidden everywhere else; decorative, the row
 * stays a window drag handle.
 */
export function TitlebarLogo() {
  return <img data-titlebar-logo="" src="/brand/openedbot-icon.webp" alt="" aria-hidden className="size-[22px] shrink-0 object-contain" />;
}

/** The sidebar collapse, in both places where it lives. */
export function SidebarToggle({ className }: { className?: string }) {
  const { t } = useT();
  const collapsed = useBoardChrome((state) => state.collapsed);
  const toggle = useBoardChrome((state) => state.toggle);
  const label = t(collapsed ? "boardui.sidebarShow" : "boardui.sidebarHide");
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={BOARD_SIDEBAR_ID}
      title={`${label} (${shortcutLabel("B")})`}
      className={cn(BAR_ICON_BUTTON, className)}
      onClick={toggle}
    >
      {/* Collapsed, the icon flips, as in BoardUI. */}
      <RiSideBarLine className={cn("size-[18px] transition-transform", COLLAPSE_MOTION, collapsed && "-scale-x-100")} aria-hidden />
    </button>
  );
}

/**
 * The « + »: a new bot or a new group. The dialogs stay those of the
 * sidebar, mounted even when collapsed: this menu only asks for them.
 */
export function CreateMenu({
  trigger,
  align = "start",
  alignOffset = 0,
}: {
  trigger: ReactNode;
  align?: "start" | "end";
  alignOffset?: number;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ask = useBoardChrome((state) => state.ask);
  // The three faces of « groupe »: the roster is already cached (sidebar).
  const bots = useQuery({
    queryKey: queryKeys.roster,
    queryFn: api.roster,
    select: (roster) => roster.bots.filter((bot) => bot.archivedAt == null),
  }).data ?? [];
  return (
    <BuiPopover open={open} onOpenChange={setOpen}>
      <BuiPopoverTrigger asChild>{trigger}</BuiPopoverTrigger>
      <BuiPopoverContent align={align} alignOffset={alignOffset} sideOffset={4} className="w-[323px] gap-1" aria-label={t("boardui.create")}>
        <CreateOption
          icon={<BotFace name={t("boardui.createBot")} seed="openedbot-new-bot" face={null} className="size-8" />}
          title={t("boardui.createBot")}
          hint={t("boardui.createBotHint")}
          onSelect={() => { setOpen(false); ask("createBot"); }}
        />
        <CreateOption
          icon={<FaceTrio bots={bots} />}
          title={t("boardui.createGroup")}
          hint={t("boardui.createGroupHint")}
          onSelect={() => { setOpen(false); ask("createGroup"); }}
        />
      </BuiPopoverContent>
    </BuiPopover>
  );
}

function CreateOption({ icon, title, hint, onSelect }: { icon: ReactNode; title: string; hint: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full cursor-pointer items-center gap-2 rounded-[14px] p-2 text-start text-text-primary outline-none openedbot-row hover:bg-background-primary-hover focus-visible:bg-background-primary-hover"
    >
      <span className="size-8 shrink-0" aria-hidden>{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-medium text-text-primary">{title}</span>
        <span className="text-body-2-medium text-text-tertiary group-hover:text-text-secondary group-focus-visible:text-text-secondary">{hint}</span>
      </span>
    </button>
  );
}

/** Three faces in a triangle, like the « Chat with your agents » icon. */
function FaceTrio({ bots }: { bots: ReadonlyArray<BotDto> }) {
  const trio = bots.slice(0, 3);
  const spots = [
    { left: 0, top: 0 },
    { left: 12.8, top: 0 },
    { left: 6.4, top: 12.8 },
  ];
  return (
    <span className="relative block size-8 shrink-0">
      {trio.map((bot, index) => (
        <span key={bot.id} className="absolute" style={spots[index]}>
          <BotFace name={bot.name} seed={bot.id} face={bot.face} animated={false} className="size-[20.8px]" />
        </span>
      ))}
    </span>
  );
}

/**
 * The top row, across the full width of the frame (sidebar and main
 * card). `slotRef` receives the slot where the screen places its header;
 * `organizationHead` is the sidebar's organization head, passed
 * by the frame so this module does not import `board-sidebar.tsx`.
 */
export function BoardTopBar({
  slotRef,
  organizationHead,
  surface = false,
  floating = false,
  lead,
  children,
  className,
}: {
  slotRef?: (element: HTMLDivElement | null) => void;
  organizationHead?: ReactNode;
  /** The rail shell keeps the scene's header inside its main surface. */
  surface?: boolean;
  floating?: boolean;
  /** Rail shell: the collapse (`RailLead`), before the header slot. */
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  const router = useRouter();
  const collapsed = useBoardChrome((state) => state.collapsed);
  const toggle = useBoardChrome((state) => state.toggle);
  const ask = useBoardChrome((state) => state.ask);
  // Re-read on every navigation: that is what changes what history allows.
  useRouterState({ select: (state) => state.location.href });
  const canGoBack = router.history.canGoBack();
  // Chromium knows whether a page follows (Navigation API); elsewhere we leave the
  // button active, the browser will ignore a `forward` with nothing after it.
  const navigation = (globalThis as { navigation?: { canGoForward?: boolean } }).navigation;
  const canGoForward = navigation?.canGoForward ?? true;
  // Bar open on desktop, the collapsed row is hidden: out of the tab order.
  // Under `md` the sidebar does not exist, so the row stays there.
  const isMobile = useIsMobile();
  const toolsHidden = !collapsed && !isMobile;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "b" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      // A rich editor keeps its bold.
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  if (surface) {
    return (
      // One line across the window: the header's row (36 px, 8 px under the card
      // top) is centred 38 px from the window top, like the conversations card's
      // head row and the macOS traffic lights (`traffic_lights.rs`, card anchor).
      <header data-board-topbar="" data-board-surface-header="" data-titlebar-drag=""
        className={cn("z-20 flex shrink-0 items-start px-3 pt-2", floating ? "pointer-events-none absolute inset-x-0 top-0 h-[72px]" : "relative h-[60px]", className)}>
        {/* Rail shell: the collapse (and, card collapsed, the card's start) before the slot (`RailLead`). */}
        {lead ? <div data-board-header-lead="" className="pointer-events-auto me-1 flex h-9">{lead}</div> : null}
        <div ref={slotRef} data-board-header-slot="" className="flex h-9 min-w-0 flex-1 items-center gap-1 [&>*]:pointer-events-auto">{children}</div>
      </header>
    );
  }

  return (
    // `data-titlebar-drag`: the window drag handle in the native macOS shell.
    <div data-board-topbar="" data-titlebar-drag="" className={cn("relative flex h-[46px] shrink-0 items-center gap-1 ps-3 pe-3", className)}>
      <div aria-hidden data-titlebar-lights="" />
      <TitlebarLogo />
      {/* Bar open (desktop): the organization, at its own width, then the collapse
          and the navigation right after it, without the gap that pinned them to
          the edge of the main card. On collapse, it leaves along the same
          grid track that the collapsed row enters on. */}
      <div
        className={cn(
          "hidden shrink-0 transition-[grid-template-columns] md:grid",
          COLLAPSE_MOTION,
          collapsed ? "grid-cols-[0fr]" : "grid-cols-[1fr]",
        )}
      >
        <div
          inert={collapsed}
          className={cn(
            "flex min-w-0 max-w-[200px] items-center overflow-x-clip transition-[opacity,transform]",
            COLLAPSE_MOTION,
            collapsed && "pointer-events-none -translate-x-2 opacity-0",
          )}
        >
          {organizationHead}
        </div>
      </div>
      <SidebarToggle className="hidden md:inline-flex" />
      {/* Bar collapsed (or a window too narrow for it): the sidebar's top
          row moves up here, in the same order. It enters and
          leaves with the bar: its width opens (grid track 0fr -> 1fr,
          which is why the breadcrumb slides instead of jumping) while it
          appears with a fade and a slide. `overflow-x-clip` clips the width
          without clipping the focus rings in height. */}
      <div
        className={cn(
          "grid shrink-0 transition-[grid-template-columns]",
          COLLAPSE_MOTION,
          collapsed ? "grid-cols-[1fr]" : "grid-cols-[1fr] md:grid-cols-[0fr]",
        )}
      >
      <div
        inert={toolsHidden}
        className={cn(
          "flex min-w-0 items-center gap-1 overflow-x-clip transition-[opacity,transform]",
          COLLAPSE_MOTION,
          !collapsed && "md:pointer-events-none md:-translate-x-2 md:opacity-0",
        )}
      >
        <button
          type="button"
          aria-label={t("appSidebar.searchAriaLabel")}
          title={`${t("appSidebar.searchAriaLabel")} (${shortcutLabel("K")})`}
          className={cn(BAR_ICON_BUTTON, "hidden md:inline-flex")}
          onClick={() => ask("search")}
        >
          <RiSearchLine className="size-[18px]" aria-hidden />
        </button>
        <CreateMenu
          trigger={(
            <button
              type="button"
              aria-label={t("boardui.create")}
              title={t("boardui.create")}
              className="ms-1 inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-background-tertiary-default text-foreground-icon-secondary hover:bg-background-tertiary-hover hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiAddFill className="size-[18px]" aria-hidden />
            </button>
          )}
        />
        <span aria-hidden className="ms-2 me-1 h-[18px] w-px shrink-0 bg-border-button-default" />
      </div>
      </div>
      <div className="flex items-center">
        <button
          type="button"
          aria-label={t("boardui.navBack")}
          title={`${t("boardui.navBack")} (Alt ←)`}
          disabled={!canGoBack}
          className={BAR_ICON_BUTTON}
          onClick={() => router.history.back()}
        >
          <RiArrowLeftSLine className="size-[18px]" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t("boardui.navForward")}
          title={`${t("boardui.navForward")} (Alt →)`}
          disabled={!canGoForward}
          className={BAR_ICON_BUTTON}
          onClick={() => router.history.forward()}
        >
          <RiArrowRightSLine className="size-[18px]" aria-hidden />
        </button>
      </div>
      <div ref={slotRef} data-board-header-slot="" className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
      {/* Outside prod, the openedbot being targeted stays in view on every screen: dev and preprod
          would otherwise look line for line like prod, in the browser
          as in the desktop app, of which this bar is the title bar. */}
      <DeployEnvironmentBadge hideProd className="ms-2 shrink-0" />
    </div>
  );
}

/**
 * A screen's header: its breadcrumb (`Salon › titre`) and its actions,
 * placed in the frame's top bar. Outside the frame (no slot),
 * it renders in place, at the same height.
 */
export function BoardHeader({
  title,
  avatar,
  actions,
  heading = true,
  root = false,
  titleAction,
  centered = false,
  floating = false,
}: {
  title: ReactNode;
  avatar?: ReactNode;
  actions?: ReactNode;
  /** `false`: the `h1` lives in the scene. */
  heading?: boolean;
  /** The Salon itself: no « Salon › » in front of its own title. */
  root?: boolean;
  /** The title becomes a button (a bot's name opens its editor). */
  titleAction?: { label: string; onClick: () => void };
  /**
   * The title alone, without « Salon › », centred across the whole bar like a window
   * title (a bot's thread). Centred from `xl` only: any narrower,
   * it would overlap the collapsed row on the left and the model on the right.
   */
  centered?: boolean;
  /** A compact title pill over the transcript, independent of the sidebar. */
  floating?: boolean;
}) {
  const { t } = useT();
  const slot = useContext(BoardHeaderSlotContext);
  const TitleTag = heading ? "h1" : "p";
  // A title can be a composite node (a group's stack of faces followed
  // by its name): it lays out in a row, and only the text truncates.
  const titleInner = (
    <>
      {avatar}
      {typeof title === "string"
        ? <span className="min-w-0 truncate">{title}</span>
        : <span className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">{title}</span>}
    </>
  );
  const content = (
    <>
      <nav
        aria-label={t("boardui.breadcrumb")}
        data-board-header-centered={centered ? "" : undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 px-1",
          floating ? "absolute top-1.5 left-1/2 max-w-[calc(100%-8rem)] flex-none -translate-x-1/2" : centered && "xl:absolute xl:top-1/2 xl:left-1/2 xl:max-w-[30%] xl:flex-none xl:-translate-x-1/2 xl:-translate-y-1/2",
        )}
      >
        {root || centered ? null : (
          <>
            <Link
              to="/"
              data-board-header-root=""
              className="shrink-0 rounded-md px-1 text-body-2-medium whitespace-nowrap text-text-secondary outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              {t("overviewPlaceholder.nav")}
            </Link>
            <span aria-hidden data-board-header-root="" className="shrink-0 text-text-tertiary">›</span>
          </>
        )}
        <TitleTag className="flex min-w-0 text-body-2-medium text-text-primary [&_svg]:shrink-0">
          {titleAction ? (
            <button
              type="button"
              onClick={titleAction.onClick}
              aria-label={titleAction.label}
              className={cn("flex min-w-0 max-w-full cursor-pointer items-center gap-2 font-semibold outline-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring", floating ? "h-10 rounded-full border border-border-button-default bg-background-secondary-default px-3 text-body-medium shadow-xs" : "h-[30px] rounded-lg px-1.5")}
            >
              {titleInner}
            </button>
          ) : (
            <span className={cn("flex min-w-0 items-center gap-2 font-semibold", floating ? "h-10 rounded-full border border-border-button-default bg-background-secondary-default px-3 text-body-medium shadow-xs" : "h-[30px] px-1.5")}>{titleInner}</span>
          )}
        </TitleTag>
      </nav>
      {/* `ms-auto`: a centred title leaves the flow, the actions stay on the right. */}
      {actions ? <div className="ms-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
    </>
  );
  if (slot) return createPortal(content, slot);
  return (
    <header data-titlebar-drag="" className="relative flex h-[46px] shrink-0 items-center gap-1 px-3">
      {content}
    </header>
  );
}
