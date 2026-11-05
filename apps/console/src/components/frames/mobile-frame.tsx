import { FleetRail, FleetTopBar, useFleetFrameContext } from "../../pro-console/slots";
import { Outlet } from "@tanstack/react-router";
import { MobileDrawerShell } from "../mobile/mobile-drawer-shell";
import { BoardSidebar } from "../boardui/board-sidebar";
import { AgentEditorPanel } from "../boardui/agent-editor-panel";
import { GlobalCommandPalette } from "../global-command-palette";
import { BotDialogsHost } from "../bot-manage/bot-dialogs-host";
import { GlobalSearchFocus } from "../global-search-focus";
import { DevRenderProfiler } from "../dev/dev-render-profiler";

/**
 * Sur un téléphone, la coque devient celle du mode `sidebar` / `assistant`
 * du template mobile : la MÊME barre latérale, mais en panneau statique sous
 * une scène qui glisse pour le révéler (`MobileDrawerShell`). Pas d'onglets ni
 * de raccourcis : comme dans ChatGPT, le panneau est la liste des
 * conversations, et la ligne de l'opérateur en bas mène au reste (aperçu,
 * historique, réglages). `collapsible="none"` : la barre se rend
 * en simple colonne, sans le `Sheet` que `Sidebar` sortirait sinon sur mobile.
 */
export function MobileFrame() {
  const fleetFrame = useFleetFrameContext();
  const fleetClient = fleetFrame?.client ?? null;
  // Chez un client, le panneau garde le rail agence et nomme le client au-dessus
  // de ses conversations ; l'en-tête de la barre perd son retrait de safe-area,
  // déjà porté par la barre `Agence / client`.
  const panel = fleetFrame ? (
    <div className="flex h-full w-full">
      <FleetRail client={fleetClient} fleetId={fleetFrame.fleet.id} />
      <div className="flex min-w-0 flex-1 flex-col">
        <FleetTopBar client={fleetClient} fleetWorkspace={fleetClient ? null : fleetFrame.fleet} className="pt-[var(--openedbot-safe-top)]" />
        <BoardSidebar className="min-h-0 w-full flex-1 rounded-none border-0 pt-2 shadow-none" />
      </div>
    </div>
  ) : <BoardSidebar className="h-full w-full rounded-none border-0 pt-[max(7px,var(--openedbot-safe-top))] pb-[max(7px,var(--openedbot-safe-bottom))] shadow-none" />;
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
