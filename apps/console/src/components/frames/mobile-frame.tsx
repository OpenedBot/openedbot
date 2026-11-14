import { Outlet } from "@tanstack/react-router";
import { MobileDrawerShell } from "../mobile/mobile-drawer-shell";
import { BoardSidebar } from "../boardui/board-sidebar";
import { AgentEditorPanel } from "../boardui/agent-editor-panel";
import { GlobalCommandPalette } from "../global-command-palette";
import { BotDialogsHost } from "../bot-manage/bot-dialogs-host";
import { GlobalSearchFocus } from "../global-search-focus";
import { DevRenderProfiler } from "../dev/dev-render-profiler";

/**
 * On a phone, the shell becomes that of the mobile template's `sidebar` / `assistant`
 * mode: the SAME sidebar, but as a static panel under
 * a scene that slides to reveal it (`MobileDrawerShell`). No tabs and no
 * shortcuts: as in ChatGPT, the panel is the list of
 * conversations, and the operator's row at the bottom leads to the rest (overview,
 * history, settings). `collapsible="none"`: the bar renders
 * as a plain column, without the `Sheet` that `Sidebar` would otherwise put out on mobile.
 */
export function MobileFrame() {
  const panel = <BoardSidebar className="h-full w-full rounded-none border-0 pt-[max(7px,var(--openedbot-safe-top))] pb-[max(7px,var(--openedbot-safe-bottom))] shadow-none" />;
  // Same dev-only profiler ids as `BoardFrame`.
  return (
    <MobileDrawerShell panel={<DevRenderProfiler id="board-sidebar">{panel}</DevRenderProfiler>}>
      <DevRenderProfiler id="app-shell">
        <GlobalCommandPalette />
        <BotDialogsHost />
        <GlobalSearchFocus />
      </DevRenderProfiler>
      <Outlet />
      <DevRenderProfiler id="agent-editor"><AgentEditorPanel /></DevRenderProfiler>
    </MobileDrawerShell>
  );
}
