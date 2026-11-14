import { useEffect, useState, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { cn } from "@openedbot/browser-ui-kit";
import { GlobalCommandPalette } from "../global-command-palette";
import { BotDialogsHost } from "../bot-manage/bot-dialogs-host";
import { GlobalSearchFocus } from "../global-search-focus";
import { DevRenderProfiler } from "../dev/dev-render-profiler";
import { AgentEditorPanel } from "./agent-editor-panel";
import { BoardSidebar, OrganizationHead } from "./board-sidebar";
import { BOARD_SIDEBAR_ID, BoardHeaderSlotProvider, BoardTopBar, COLLAPSE_MOTION, useBoardChrome } from "./board-chrome";
import { rememberAppPath } from "../../lib/shell/settings-return";
import { useAccountLayout } from "../../lib/shell/account-layout";
import { RailLead } from "./board-rails";
import { TITLEBAR_ANCHOR_ATTRIBUTE } from "../../lib/platform/native-titlebar";
import { OrganizationStreamProjection } from "../../lib/stream/organization-projection";
import { isConversationPath } from "../../lib/session/boot-shape";

/**
 * The desktop frame, on the surfaces of BoardUI's « Chat Starter » template:
 * on the frame's white background (`background-full`), grey cards with a radius
 * of 24 px, no border and no shadow, separated by 12 px. The 46 px top bar
 * (`board-chrome.tsx`) stays on the frame background: it is the title bar
 * of the native window. Under it, the conversations card (260 px,
 * collapsible, its 46 px head above it), the main card, then
 * the agent editor (356 px) when a thread is open.
 *
 * `main` carries the route's screen; the frame's panels (agent
 * editor, palette) are mounted once here.
 */

export function BoardFrame({ children, overlay, sidebar }: {
  children: ReactNode;
  overlay?: ReactNode;
  /**
   * Replaces the conversations sidebar in the same column (same width, same
   * collapse): the settings menu when settings are a page, as in OpenTrack.
   */
  sidebar?: ReactNode;
}) {
  // The path alone: `useLocation` re-rendered the whole frame (sidebar
  // included) on every history-state change, settings overlay included.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => rememberAppPath(), [pathname]);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const collapsed = useBoardChrome((state) => state.collapsed);
  // Variant C: no top bar, no icon rail; the conversations card carries the
  // rail's buttons (`RailHead`, `RailFooter`), the cards start 12 px from the top.
  const railShell = useAccountLayout() === "c";
  const floatingThread = railShell && isConversationPath(pathname) && /\/bot\//.test(pathname);
  // The desktop app places the macOS traffic lights in the card's head row
  // (rail shell) or on the top bar (`tauri-shell.ts`, `set_titlebar_anchor`).
  // Kept when the frame unmounts: sign-in leaves them where they are; onboarding
  // asks for « bar », its own title bar row (`step-shell.tsx`).
  useEffect(() => {
    document.documentElement.setAttribute(TITLEBAR_ANCHOR_ATTRIBUTE, railShell ? "card" : "bar");
  }, [railShell]);
  // `DevRenderProfiler` (dev only): the perf HUD attributes a render
  // to the bar, the frame chrome or the agent editor, not only to the thread.
  return (
    <div data-board-flush={railShell ? "" : undefined} className={cn("relative flex h-full min-h-0 w-full min-w-0 flex-1 overflow-clip bg-background-full text-text-primary", railShell && "pt-3")}>
      {/* The top bar runs the full width, above the conversations
          card and the main card: bar open,
          the organization, the collapse and the navigation follow one another with no gap. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {railShell ? null : <BoardTopBar slotRef={setHeaderSlot} organizationHead={<OrganizationHead />} />}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Collapsed, the bar stays mounted (its creation dialogs, in
              a portal, and its search serve the top bar). The collapse is
              that of the boardui.com Dashboard: only this column's width
              animates (272 -> 0 px, 300 ms, `ease-in-out`), the card follows. The
              column is the clip: with no margin and no border, `overflow-clip` (a box
              `hidden` still scrolls programmatically: a focus inside the bar
              shifted it left, Firefox and the native shell), and the
              bar inside keeps its 272 px, so neither does its text wrap nor do its
              margins overflow onto the header or the card. */}
          <div
            id={BOARD_SIDEBAR_ID}
            inert={collapsed}
            className={cn(
              "hidden min-h-0 shrink-0 overflow-clip transition-[width] md:block",
              COLLAPSE_MOTION,
              collapsed ? "w-0" : "w-[272px]",
            )}
          >
            <DevRenderProfiler id="board-sidebar">{sidebar ?? <BoardSidebar />}</DevRenderProfiler>
          </div>
          <DevRenderProfiler id="app-shell">
            <GlobalCommandPalette />
            <BotDialogsHost />
            <GlobalSearchFocus />
            <OrganizationStreamProjection />
          </DevRenderProfiler>
          {/* `--agent-glyph-mask`: the glyphs of a turn's activity (ui-kit
              `agent/*`) mask the trace trunk with this background. Without it, they
              took `--color-background` (white) and formed a white square
              on the grey card.
              As in BoardUI, the card has neither border nor shadow: the grey on the
              frame's white is enough. Its left margin (12 px) is the gap with the
              conversations card, or with the window edge when collapsed. */}
          <div className="flex min-h-0 min-w-0 flex-1 ps-3 pe-3 pb-3">
            <main data-board-floating-thread={floatingThread ? "" : undefined} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-3xl bg-background-secondary-default [--agent-glyph-mask:var(--bui-background-secondary-default)]">
              {/* The collapse, left of the breadcrumb; card collapsed, the card's
                  start (logo or traffic lights) comes along, at its head-row height. */}
              {railShell ? <BoardTopBar surface floating={floatingThread} slotRef={setHeaderSlot} lead={<RailLead collapsed={collapsed} />} /> : null}
              <BoardHeaderSlotProvider value={headerSlot}>
                {children}
              </BoardHeaderSlotProvider>
            </main>
            <DevRenderProfiler id="agent-editor"><AgentEditorPanel /></DevRenderProfiler>
          </div>
        </div>
      </div>
      {overlay}
    </div>
  );
}
