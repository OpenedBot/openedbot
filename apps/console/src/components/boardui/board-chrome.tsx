import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { RiAddFill, RiArrowLeftSLine, RiArrowRightSLine, RiSearchLine, RiSideBarLine } from "@remixicon/react";
import type { BotDto } from "@openedbot/contracts-api";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { shortcutLabel } from "../../lib/shortcut-label";
import { useT } from "../../lib/i18n";
import { BotFace } from "../bot-face";
import { DeployEnvironmentBadge } from "../deploy-environment-badge";
import { BuiPopover, BuiPopoverContent, BuiPopoverTrigger } from "./menu";

/**
 * La barre du haut du cadre de bureau, à la manière de Codex ou d'OpenBot :
 * une seule rangée de 46 px sur toute la largeur, au-dessus de la barre
 * latérale et de la carte principale, sur le fond du cadre.
 *
 * - au-dessus de la barre latérale : l'organisation et le repli (`Ctrl B`) ;
 * - au-dessus de la carte : Précédent / Suivant, puis l'en-tête de l'écran
 *   affiché (fil d'Ariane et actions), que chaque écran y pose par portail
 *   (`BoardHeader`) sans que le cadre le connaisse.
 *
 * Barre repliée, sa première rangée (recherche, Boutique, « + ») monte dans
 * cette barre : rien ne disparaît avec elle.
 */

const COLLAPSED_KEY = "ohb:sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Ce que la barre latérale doit faire alors qu'on l'a demandé d'ailleurs. */
export type BoardChromeRequest = { kind: "search" | "createBot" | "createGroup"; at: number };

type BoardChromeState = {
  collapsed: boolean;
  toggle: () => void;
  /** La barre latérale lit la dernière demande et l'exécute une fois (`at`). */
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
      // Navigation privée : le repli vaut pour la session seulement.
    }
    set({ collapsed });
  },
  request: null,
  // La recherche vit dans la barre : la demander rouvre la barre d'abord.
  ask: (kind) => {
    if (kind === "search" && get().collapsed) get().toggle();
    set({ request: { kind, at: Date.now() } });
  },
}));

/** L'emplacement de l'en-tête d'écran dans la barre du haut, `null` hors du cadre. */
const BoardHeaderSlotContext = createContext<HTMLElement | null>(null);
export const BoardHeaderSlotProvider = BoardHeaderSlotContext.Provider;

/** Les boutons ronds de 30 px de la barre du haut. */
export const BAR_ICON_BUTTON =
  "inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary outline-none transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:pointer-events-none disabled:opacity-35";

/** La colonne repliable de la barre latérale (`BoardFrame`), cible d'`aria-controls`. */
export const BOARD_SIDEBAR_ID = "ohb-board-sidebar";

/**
 * Les transitions du repli, celles de la barre du Dashboard de boardui.com :
 * 300 ms, `ease-in-out`, tout part ensemble, sans décalage.
 */
export const COLLAPSE_MOTION = "duration-300 ease-in-out motion-reduce:transition-none";

/** Le repli de la barre latérale, aux deux endroits où il vit. */
type SidebarControl = { id: string; collapsed: boolean; onToggle: () => void };

export function SidebarToggle({ className, control }: { className?: string; control?: SidebarControl }) {
  const { t } = useT();
  const personalCollapsed = useBoardChrome((state) => state.collapsed);
  const personalToggle = useBoardChrome((state) => state.toggle);
  const collapsed = control?.collapsed ?? personalCollapsed;
  const toggle = control?.onToggle ?? personalToggle;
  const label = t(collapsed ? "boardui.sidebarShow" : "boardui.sidebarHide");
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={control?.id ?? BOARD_SIDEBAR_ID}
      title={`${label} (${shortcutLabel("B")})`}
      className={cn(BAR_ICON_BUTTON, className)}
      onClick={toggle}
    >
      {/* Repliée, l'icône se retourne, comme chez BoardUI. */}
      <RiSideBarLine className={cn("size-[18px] transition-transform", COLLAPSE_MOTION, collapsed && "-scale-x-100")} aria-hidden />
    </button>
  );
}

/**
 * Le « + » : nouveau bot ou nouveau groupe. Les dialogues restent ceux de la
 * barre latérale, montée même repliée : ce menu ne fait que les demander.
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
  // Les trois visages du « groupe » : le roster est déjà en cache (barre latérale).
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
          icon={<BotFace name={t("boardui.createBot")} seed="ohb-new-bot" face={null} className="size-8" />}
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
      className="group flex w-full cursor-pointer items-center gap-2 rounded-[14px] p-2 text-start text-text-primary outline-none ohb-row hover:bg-background-primary-hover focus-visible:bg-background-primary-hover"
    >
      <span className="size-8 shrink-0" aria-hidden>{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-medium text-text-primary">{title}</span>
        <span className="text-body-2-medium text-text-tertiary group-hover:text-text-secondary group-focus-visible:text-text-secondary">{hint}</span>
      </span>
    </button>
  );
}

/** Trois visages en triangle, comme l'icône « Chat with your agents ». */
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
 * La rangée du haut, sur toute la largeur du cadre (barre latérale et carte
 * principale). `slotRef` reçoit l'emplacement où l'écran pose son en-tête ;
 * `organizationHead` est la tête d'organisation de la barre latérale, passée
 * par le cadre pour que ce module n'importe pas `board-sidebar.tsx`.
 */
export function BoardTopBar({
  slotRef,
  organizationHead,
  sidebarControl,
  workspaceTools = true,
  children,
  className,
}: {
  slotRef?: (element: HTMLDivElement | null) => void;
  organizationHead?: ReactNode;
  sidebarControl?: SidebarControl;
  /** Fleet navigation has client search instead of bot creation tools. */
  workspaceTools?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  const router = useRouter();
  const personalCollapsed = useBoardChrome((state) => state.collapsed);
  const personalToggle = useBoardChrome((state) => state.toggle);
  const collapsed = sidebarControl?.collapsed ?? personalCollapsed;
  const toggle = sidebarControl?.onToggle ?? personalToggle;
  const headCollapsed = workspaceTools && collapsed;
  const ask = useBoardChrome((state) => state.ask);
  // Relu à chaque navigation : c'est elle qui change ce que l'historique permet.
  useRouterState({ select: (state) => state.location.href });
  const canGoBack = router.history.canGoBack();
  // Chromium sait si une page suit (Navigation API) ; ailleurs on laisse le
  // bouton actif, le navigateur ignorera un `forward` sans suite.
  const navigation = (globalThis as { navigation?: { canGoForward?: boolean } }).navigation;
  const canGoForward = navigation?.canGoForward ?? true;
  // Barre ouverte au bureau, la rangée repliée est cachée : hors du clavier.
  // Sous `md` la barre latérale n'existe pas, la rangée reste là.
  const isMobile = useIsMobile();
  const toolsHidden = !collapsed && !isMobile;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "b" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      // Un éditeur riche garde son gras.
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return (
    // `data-titlebar-drag` : poignée de la fenêtre dans la coque native macOS.
    <div data-board-topbar="" data-titlebar-drag="" className={cn("relative flex h-[46px] shrink-0 items-center gap-1 ps-3 pe-3", className)}>
      <div aria-hidden data-titlebar-lights="" />
      {/* Barre ouverte (bureau) : l'organisation, à sa largeur, puis le repli
          et la navigation juste après elle, sans le vide qui les calait sur
          le bord de la carte principale. Au repli, elle sort par la même
          piste de grille que la rangée repliée entre. */}
      <div
        className={cn(
          "hidden shrink-0 transition-[grid-template-columns] md:grid",
          COLLAPSE_MOTION,
          headCollapsed ? "grid-cols-[0fr]" : "grid-cols-[1fr]",
        )}
      >
        <div
          inert={headCollapsed}
          className={cn(
            "flex min-w-0 max-w-[200px] items-center overflow-x-clip transition-[opacity,transform]",
            COLLAPSE_MOTION,
            headCollapsed && "pointer-events-none -translate-x-2 opacity-0",
          )}
        >
          {organizationHead}
        </div>
      </div>
      <SidebarToggle control={sidebarControl} className="hidden md:inline-flex" />
      {/* Barre repliée (ou fenêtre trop étroite pour elle) : la rangée du haut
          de la barre latérale monte ici, dans le même ordre. Elle entre et
          sort avec la barre : sa largeur s'ouvre (piste de grille 0fr -> 1fr,
          d'où le fil d'Ariane qui glisse au lieu de sauter) pendant qu'elle
          apparaît en fondu et en glissé. `overflow-x-clip` rogne la largeur
          sans rogner les anneaux de focus en hauteur. */}
      {workspaceTools && <div
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
              className="ms-1 inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-button-primary text-text-white outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              <RiAddFill className="size-[18px]" aria-hidden />
            </button>
          )}
        />
        <span aria-hidden className="ms-2 me-1 h-[18px] w-px shrink-0 bg-border-button-default" />
      </div>
      </div>}
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
      {/* Hors prod, l'openedbot visé reste en vue sur chaque écran : dev et préprod
          ressemblent sinon trait pour trait à la prod, dans le navigateur
          comme dans l'app desktop, dont cette barre est la barre de titre. */}
      <DeployEnvironmentBadge hideProd className="ms-2 shrink-0" />
    </div>
  );
}

/**
 * L'en-tête d'un écran : son fil d'Ariane (`Salon › titre`) et ses actions,
 * posés dans la barre du haut du cadre. Hors du cadre (pas d'emplacement),
 * il se rend sur place, à la même hauteur.
 */
export function BoardHeader({
  title,
  avatar,
  actions,
  heading = true,
  root = false,
  titleAction,
  centered = false,
}: {
  title: ReactNode;
  avatar?: ReactNode;
  actions?: ReactNode;
  /** `false` : le `h1` vit dans la scène. */
  heading?: boolean;
  /** Le Salon lui-même : pas de « Salon › » devant son propre titre. */
  root?: boolean;
  /** Le titre devient un bouton (le nom d'un bot ouvre son éditeur). */
  titleAction?: { label: string; onClick: () => void };
  /**
   * Le titre seul, sans « Salon › », centré sur toute la barre comme un titre
   * de fenêtre (fil d'un bot). Centré à partir de `xl` seulement : plus étroit,
   * il chevaucherait la rangée repliée à gauche et le modèle à droite.
   */
  centered?: boolean;
}) {
  const { t } = useT();
  const slot = useContext(BoardHeaderSlotContext);
  const TitleTag = heading ? "h1" : "p";
  // Un titre peut être un nœud composé (la pile de visages d'un groupe suivie
  // de son nom) : il se range en ligne, le texte seul se tronque.
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
          centered && "xl:absolute xl:top-1/2 xl:left-1/2 xl:max-w-[30%] xl:flex-none xl:-translate-x-1/2 xl:-translate-y-1/2",
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
              className="flex h-[30px] min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 font-semibold outline-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              {titleInner}
            </button>
          ) : (
            <span className="flex h-[30px] min-w-0 items-center gap-2 px-1.5 font-semibold">{titleInner}</span>
          )}
        </TitleTag>
      </nav>
      {/* `ms-auto` : un titre centré sort du flux, les actions restent à droite. */}
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
