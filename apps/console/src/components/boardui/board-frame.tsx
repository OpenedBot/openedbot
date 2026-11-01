import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { cn } from "@openedbot/browser-ui-kit";
import { activeOwnFleetHint, FleetClientFrame, useFleetFrameContext } from "../../pro-console/slots";
import { useAccountWorkspaces } from "../workspace/workspace-navigation";
import { FleetFrameSkeleton } from "../skeletons/frame-skeletons";
import { GlobalCommandPalette } from "../global-command-palette";
import { BotDialogsHost } from "../bot-manage/bot-dialogs-host";
import { GlobalSearchFocus } from "../global-search-focus";
import { DevRenderProfiler } from "../dev/dev-render-profiler";
import { AgentEditorPanel } from "./agent-editor-panel";
import { BoardSidebar, OrganizationHead } from "./board-sidebar";
import { BOARD_SIDEBAR_ID, BoardHeaderSlotProvider, BoardTopBar, COLLAPSE_MOTION, useBoardChrome } from "./board-chrome";
import { rememberAppPath } from "../../lib/shell/settings-return";
import { useAccountLayout } from "../../lib/shell/account-layout";
import { BoardIconRail } from "./board-rails";

/**
 * Le cadre de bureau, aux surfaces du template « Chat Starter » de BoardUI :
 * sur le fond blanc du cadre (`background-full`), des cartes grises au rayon
 * de 24 px, sans bord ni ombre, séparées de 12 px. La barre du haut de 46 px
 * (`board-chrome.tsx`) reste sur le fond du cadre : c'est la barre de titre
 * de la fenêtre native. Dessous, la carte des conversations (260 px,
 * repliable, sa tête de 46 px au-dessus d'elle), la carte principale, puis
 * l'éditeur d'agent (356 px) quand un fil est ouvert.
 *
 * `main` porte l'écran de la route ; les panneaux du cadre (éditeur
 * d'agent, palette) sont montés une fois ici.
 *
 * À droite de `main`, un emplacement vide : un écran y monte par portail sa
 * carte sœur (l'historique du support, comme la carte « Chat history » du
 * template « Chat Starter »), sans que le cadre connaisse l'écran.
 */
const BoardAsideContext = createContext<HTMLElement | null>(null);

/** L'emplacement à droite de la carte principale, `null` hors du cadre. */
export function useBoardAside(): HTMLElement | null {
  return useContext(BoardAsideContext);
}

export function BoardFrame({ children, overlay, sidebar }: {
  children: ReactNode;
  overlay?: ReactNode;
  /**
   * Replaces the conversations sidebar in the same column (same width, same
   * collapse): the settings menu when settings are a page, as in OpenTrack.
   */
  sidebar?: ReactNode;
}) {
  const fleetFrame = useFleetFrameContext();
  const accountPending = useAccountWorkspaces().isPending;
  const fleetClient = fleetFrame?.client ?? null;
  // Le chemin seul : `useLocation` re-rendait tout le cadre (barre latérale
  // comprise) à chaque changement d'état d'historique, surcouche des réglages incluse.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => rememberAppPath(), [pathname]);
  const [aside, setAside] = useState<HTMLDivElement | null>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const collapsed = useBoardChrome((state) => state.collapsed);
  // Variante C (dev) : rail d'icônes sur le fond du cadre, sans nom ni
  // sélecteur d'organisation en tête de barre.
  const railShell = useAccountLayout() === "c";
  // A client operated by its agency, and the agency's own pages, stay in the
  // agency frame (client list, agency bar, client tabs): never a workspace chrome.
  // Until the account is read, an agency session would paint the personal
  // frame for a beat (`useFleetFrameContext` is still `null`): keep the agency outline.
  if (!fleetFrame && accountPending && activeOwnFleetHint()) {
    return <><FleetFrameSkeleton />{overlay}</>;
  }
  if (fleetFrame) {
    return (
      <>
        <FleetClientFrame fleet={fleetFrame.fleet} client={fleetClient} slotRef={setHeaderSlot}
          aside={<>
            <div ref={setAside} data-board-aside="" className="contents" />
            <DevRenderProfiler id="agent-editor"><AgentEditorPanel /></DevRenderProfiler>
          </>}>
          <BoardHeaderSlotProvider value={headerSlot}>
            <BoardAsideContext.Provider value={aside}>{children}</BoardAsideContext.Provider>
          </BoardHeaderSlotProvider>
        </FleetClientFrame>
        <DevRenderProfiler id="app-shell">
          <GlobalCommandPalette />
          <BotDialogsHost />
          <GlobalSearchFocus />
        </DevRenderProfiler>
        {overlay}
      </>
    );
  }
  // `DevRenderProfiler` (dev only, OHB-141): the perf HUD attributes a render
  // to the bar, the frame chrome or the agent editor, not only to the thread.
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 overflow-clip bg-background-full text-text-primary">
      {railShell ? <BoardIconRail /> : null}
      {/* La barre du haut court sur toute la largeur, au-dessus de la carte
          des conversations et de la carte principale : barre ouverte,
          l'organisation, le repli et la navigation se suivent sans vide. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <BoardTopBar slotRef={setHeaderSlot} organizationHead={railShell ? undefined : <OrganizationHead />} />
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Repliée, la barre reste montée (ses dialogues de création, en
              portail, et sa recherche servent la barre du haut). Le repli est
              celui du Dashboard de boardui.com : seule la largeur de cette colonne
              s'anime (272 -> 0 px, 300 ms, `ease-in-out`), la carte suit. La
              colonne est le rognage : sans marge ni bord, `overflow-clip` (une boîte
              `hidden` défile encore par programme : un focus dans la barre la
              décalait à gauche, Firefox et coque native), et la
              barre dedans garde ses 272 px, donc ni son texte ne se replie ni ses
              marges ne débordent sur l'en-tête ou la carte. */}
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
          </DevRenderProfiler>
          {/* `--agent-glyph-mask` : les glyphes de l'activité d'un tour (ui-kit
              `agent/*`) masquent le tronc de la trace avec ce fond. Sans lui, ils
              prenaient `--color-background` (blanc) et formaient un carré blanc
              sur la carte grise.
              Comme chez BoardUI, la carte n'a ni bord ni ombre : le gris sur le
              blanc du cadre suffit. Sa marge gauche (12 px) est l'écart avec la
              carte des conversations, ou avec le bord de la fenêtre au repli. */}
          <div className="flex min-h-0 min-w-0 flex-1 ps-3 pe-3 pb-3">
            <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-3xl bg-background-secondary-default [--agent-glyph-mask:var(--bui-background-secondary-default)]">
              <BoardHeaderSlotProvider value={headerSlot}>
                <BoardAsideContext.Provider value={aside}>{children}</BoardAsideContext.Provider>
              </BoardHeaderSlotProvider>
            </main>
            <div ref={setAside} data-board-aside="" className="contents" />
            <DevRenderProfiler id="agent-editor"><AgentEditorPanel /></DevRenderProfiler>
          </div>
        </div>
      </div>
      {overlay}
    </div>
  );
}
