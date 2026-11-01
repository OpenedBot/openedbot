import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "@openedbot/browser-ui-kit";
import { haptics } from "../../lib/platform/haptics";
import { useT } from "../../lib/i18n";
import { clamp } from "../../lib/format";
import { releaseComposerKeyboard } from "../../lib/composer/composer-keyboard";
import {
  DRAWER_EDGE_WIDTH,
  decideDrawerOpen,
  drawerPathChange,
  drawerWidthFor,
  edgeSwipePreventsScroll,
} from "../../lib/shell/mobile-navigation";
import { sheetOwnsEdgeSwipe } from "./sheet-stack";

/** iOS retarde le `click` synthétique (~300 ms). En dessous, le garde lâche. */
const GHOST_CLICK_MS = 450;
/**
 * Quand Safari confisque le geste de bord pour SON « Retour », le `popstate`
 * n'arrive qu'au lever du doigt, bien après le `touchcancel` qu'il nous
 * envoie en le prenant. Le chemin reste tenu jusque-là, ou jusqu'à ce délai.
 */
const SWIPE_BACK_HOLD_MS = 3000;

/**
 * La coque mobile : le `SidebarNav` / `AssistantNav` du template, en DOM.
 *
 * Même géométrie que `drawerType: 'back'` d'expo-router : le panneau est
 * STATIQUE dessous, c'est la scène qui glisse vers la droite pour le révéler
 * (le comportement de ChatGPT sur iOS). La scène est la carte : ses coins
 * gauches s'arrondissent pendant qu'elle bouge ; le panneau reste une surface
 * plate et carrée. Un voile givré (`backdrop-filter`) suit la glissade et
 * gèle le contenu poussé, comme `SceneBlurOverlay`.
 *
 * Le geste : une bande de `DRAWER_EDGE_WIDTH` (40 px) sur le bord gauche
 * ouvre au balayage ; la scène poussée se ferme au tap ou au balayage
 * vers la gauche. Une navigation ferme toujours le panneau : c'est lui,
 * l'animation de changement d'écran entre deux écrans du drawer.
 */
type DrawerContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

const MobileDrawerContext = createContext<DrawerContextValue | null>(null);

/** `null` hors de la coque mobile : l'en-tête sait alors rendre sa version bureau. */
export function useMobileDrawer(): DrawerContextValue | null {
  return useContext(MobileDrawerContext);
}

/** Durée et courbe de la glissade : celles de react-native-drawer-layout sur web. */
const SLIDE_MS = 300;
const SLIDE = `${SLIDE_MS}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
/** Fraction de la course à laquelle le givre est à pleine force (template : 0.2). */
const BLUR_RAMP_END = 0.2;
/** Rayon des coins gauches de la carte pendant qu'elle bouge. */
const SCENE_RADIUS = 16;
/** Au-delà, un déplacement est un balayage et non un tap. */
const DRAG_SLOP = 8;

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  fromOpen: boolean;
  captured: boolean;
  aborted: boolean;
  lastX: number;
  lastT: number;
  velocity: number;
};

function useDrawerWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 310 : drawerWidthFor(window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setWidth(drawerWidthFor(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export function MobileDrawerShell({
  panel,
  children,
  className,
  style,
}: {
  /** Le contenu du panneau : la barre latérale des conversations. */
  panel: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useT();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const width = useDrawerWidth();
  const [open, setOpenState] = useState(false);
  /** Position pendant un balayage, en px ; `null` au repos. */
  const [dragX, setDragX] = useState<number | null>(null);
  /** Le panneau reste `inert` le temps du click iOS retardé ; le hamburger n'arme pas ça. */
  const [panelLocked, setPanelLocked] = useState(false);
  const drag = useRef<Drag | null>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const ignoreClick = useRef(false);
  /**
   * Chemin à restaurer si le swipe-back iOS change l'URL. Armé dès le
   * `touchstart` sur la bande de bord, PAS au pointerup : quand Safari prend
   * le geste pour son « Retour », il coupe la séquence par un `touchcancel`
   * avant tout `pointerup` : aucun drag n'était capturé, rien n'était armé,
   * et le `popstate` qui suivait nous déposait sur l'écran d'avant (`/`).
   */
  const holdPath = useRef<string | null>(null);
  /** Un `popstate` a été vu pendant que le chemin était tenu. */
  const popped = useRef(false);
  /** Dernier chemin RÉELLEMENT visité (cf. l'effet de fermeture plus bas). */
  const lastPath = useRef(pathname);
  const holdTimer = useRef(0);
  const ghostTimer = useRef(0);

  const setOpen = useCallback((next: boolean) => {
    if (next) releaseComposerKeyboard();
    setOpenState((current) => {
      if (current !== next) haptics.light();
      return next;
    });
  }, []);
  const toggle = useCallback(() => setOpenState((current) => {
    if (!current) releaseComposerKeyboard();
    haptics.light();
    return !current;
  }), []);

  const armGhostClickGuard = useCallback(() => {
    ignoreClick.current = true;
    setPanelLocked(true);
    window.clearTimeout(ghostTimer.current);
    ghostTimer.current = window.setTimeout(() => {
      ignoreClick.current = false;
      setPanelLocked(false);
    }, GHOST_CLICK_MS);
  }, []);

  /** Tient le chemin courant le temps qu'un « Retour » système se déclare. */
  const holdCurrentPath = useCallback(() => {
    window.clearTimeout(holdTimer.current);
    holdPath.current = lastPath.current;
    popped.current = false;
  }, []);
  const releaseHeldPath = useCallback((afterMs: number) => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      holdPath.current = null;
      popped.current = false;
    }, afterMs);
  }, []);

  // Le `popstate` est le seul signe fiable du swipe-back : un lien tapé dans
  // le panneau est un push, il ne doit jamais être annulé, même tenu.
  useEffect(() => {
    const onPop = () => {
      if (holdPath.current !== null) popped.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Toute navigation ferme le panneau, sauf le swipe-back iOS, qu'on annule :
  // le hamburger n'y touche pas, le geste de bord si (même bande que « Retour »).
  //
  // Le garde `lastPath` est ce qui rend l'effet insensible au re-rendu : sans
  // lui, toute nouvelle identité de `navigate` (et le montage lui-même) le
  // rejouait et fermait un panneau que personne n'avait touché.
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    const held = holdPath.current;
    const change = drawerPathChange({ held, pathname, popped: popped.current });
    popped.current = false;
    if (change === "restore" && held !== null) {
      void navigate({ to: held, replace: true });
      setOpenState(true);
      return;
    }
    if (change === "keep-open") {
      holdPath.current = null;
      setOpenState(true);
      return;
    }
    holdPath.current = null;
    setOpenState(false);
  }, [pathname, navigate]);

  // Échap ferme, comme un dialogue : le panneau ouvert est modal pour la scène.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Une feuille portailée (réglages opérateur) est au-dessus : Échap
      // la ferme, le tiroir reste ouvert.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // Un lien du panneau qui mène là où l'on est déjà ne change pas `pathname` :
  // fermer sur le clic (capture, avant la navigation) couvre ce cas aussi.
  const closeOnLink = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest("a[href]")) setOpen(false);
  };

  // Le `click` suit le `pointerup` sur l'élément sous le doigt. Après un
  // balayage ça tombe sur le voile (`data-drawer-scrim`), le lien marque
  // (`/`) ou une ligne du roster, d'où le snap-close et la redirection
  // vers l'aperçu au simple geste d'ouverture.
  useEffect(() => {
    const blockGhostClick = (event: MouseEvent) => {
      if (!ignoreClick.current) return;
      // La cible D'ABORD : consommer le garde sur un clic hors panneau *et*
      // hors voile le désarmait pour le vrai clic fantôme qui suivait.
      if (!(event.target instanceof Element)) return;
      const inPanel = event.target.closest("[data-mobile-drawer]");
      const inScrim = event.target.closest("[data-drawer-scrim]");
      const inScene = event.target.closest("[data-mobile-scene]");
      if (!inPanel && !inScrim && !inScene) return;
      ignoreClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", blockGhostClick, true);
    return () => document.removeEventListener("click", blockGhostClick, true);
  }, []);

  // React pose `touchstart` en passif : `preventDefault` sur la bande est
  // ignoré, et iOS prend le geste pour un Retour. Listener natif, non passif.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let fromEdge = false;
    let startX = 0;
    let startY = 0;
    const onStart = (event: TouchEvent) => {
      // Un nouveau doigt clôt le geste précédent : ce qu'il tenait est rendu.
      window.clearTimeout(holdTimer.current);
      holdPath.current = null;
      popped.current = false;
      if (sheetOwnsEdgeSwipe()) {
        fromEdge = false;
        return;
      }
      const touch = event.touches[0];
      startX = touch?.clientX ?? 99;
      startY = touch?.clientY ?? 0;
      const atEdge = startX <= DRAWER_EDGE_WIDTH;
      fromEdge = !open && atEdge;
      // Panneau ouvert ou fermé : Safari peut confisquer ce bord pour « Retour ».
      if (atEdge) holdCurrentPath();
    };
    // Séquence finie normalement : plus qu'un click retardé à couvrir.
    const onEnd = () => releaseHeldPath(GHOST_CLICK_MS);
    // Séquence confisquée (Safari « Retour ») : le `popstate` viendra au
    // lever du doigt, on ne sait pas quand.
    const onCancel = () => releaseHeldPath(SWIPE_BACK_HOLD_MS);
    const onMove = (event: TouchEvent) => {
      if (sheetOwnsEdgeSwipe()) return;
      const touch = event.touches[0];
      const dx = (touch?.clientX ?? startX) - startX;
      const dy = (touch?.clientY ?? startY) - startY;
      if (fromEdge && !drag.current?.captured) {
        if (Math.abs(dy) > DRAG_SLOP && Math.abs(dy) > Math.abs(dx)) {
          fromEdge = false;
        }
      }
      if (!edgeSwipePreventsScroll({
        fromEdge,
        captured: Boolean(drag.current?.captured),
        aborted: Boolean(drag.current?.aborted),
        dx,
        dy,
      })) return;
      if (event.cancelable) event.preventDefault();
    };
    shell.addEventListener("touchstart", onStart, { passive: true });
    shell.addEventListener("touchmove", onMove, { passive: false });
    shell.addEventListener("touchend", onEnd, { passive: true });
    shell.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      shell.removeEventListener("touchstart", onStart);
      shell.removeEventListener("touchmove", onMove);
      shell.removeEventListener("touchend", onEnd);
      shell.removeEventListener("touchcancel", onCancel);
    };
  }, [open, holdCurrentPath, releaseHeldPath]);

  useEffect(() => () => {
    window.clearTimeout(holdTimer.current);
    window.clearTimeout(ghostTimer.current);
  }, []);

  // Les menus Radix (menu de l'opérateur) sont portés hors du panneau : une
  // destination choisie là ne passe pas par `closeOnLink`.
  //
  // `[data-closes-drawer]` et NON `[role="menuitem"]` : tout item Radix porte
  // ce rôle, y compris ceux qui ne naviguent pas : épingler un bot, basculer
  // le thème, ouvrir la feuille « Nouveau groupe ». Le panneau se fermait
  // alors sous un geste qui ne changeait pas d'écran, et la feuille
  // s'ouvrait sur une scène dont le tiroir venait de disparaître. Seuls les
  // items qui mènent ailleurs portent l'attribut (voir `account-menu.tsx`).
  useEffect(() => {
    if (!open) return;
    const closeOnMenuItem = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-closes-drawer]")) return;
      queueMicrotask(() => setOpen(false));
    };
    document.addEventListener("click", closeOnMenuItem, true);
    return () => document.removeEventListener("click", closeOnMenuItem, true);
  }, [open, setOpen]);

  const beginDrag = (fromOpen: boolean) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!fromOpen && (sheetOwnsEdgeSwipe() || event.clientX > DRAWER_EDGE_WIDTH)) return;
    if (event.button !== 0 || !event.isPrimary) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      fromOpen,
      captured: false,
      aborted: false,
      lastX: event.clientX,
      lastT: event.timeStamp,
      velocity: 0,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.aborted) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.captured) {
      if (Math.abs(dy) > DRAG_SLOP && Math.abs(dy) > Math.abs(dx)) {
        current.aborted = true;
        return;
      }
      if (Math.abs(dx) < DRAG_SLOP) return;
      current.captured = true;
      // Après le slop seulement : un tap sur le voile doit encore fermer.
      (shellRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
      // Pendant le swipe, pas à la fin : sinon le clavier reste et le
      // visualViewport reste rétréci jusqu'au pointerup.
      if (!current.fromOpen) releaseComposerKeyboard();
    }
    const dt = Math.max(1, event.timeStamp - current.lastT);
    current.velocity = (event.clientX - current.lastX) / dt;
    current.lastX = event.clientX;
    current.lastT = event.timeStamp;
    setDragX(clamp((current.fromOpen ? width : 0) + dx, 0, width));
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!current.captured) {
      setDragX(null);
      return;
    }
    const position = clamp((current.fromOpen ? width : 0) + (event.clientX - current.startX), 0, width);
    const next = decideDrawerOpen({ position, width, velocity: current.velocity });
    setDragX(null);
    if (next && !current.fromOpen) armGhostClickGuard();
    setOpen(next);
  };

  const dragging = dragX !== null;
  const progress = dragging ? dragX / width : open ? 1 : 0;
  const offset = progress * width;
  const shown = progress > 0;
  const moving = dragging || open;
  // Au repos, pas de `translate3d(0,0,0)` ni de `will-change: transform`.
  // Les deux font de la scène un ancêtre transformé même tiroir fermé :
  // en PWA iOS, WebKit peint alors le filtre (et la barre d'état
  // `black-translucent`) sur l'en-tête, pas sur le contenu qui défile.
  // La couche reste le temps de la glissade de retour, puis elle tombe.
  const [holdLayer, setHoldLayer] = useState(false);
  useEffect(() => {
    if (moving) {
      setHoldLayer(true);
      return;
    }
    const timer = window.setTimeout(() => setHoldLayer(false), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [moving]);
  const sceneLayer = moving || holdLayer;
  // Pendant le swipe, et 450 ms après une ouverture au geste : le voile
  // existe visuellement mais ne reçoit ni click ni pointer. Le hamburger
  // n'arme pas panelLocked → tap-pour-fermer immédiat inchangé.
  const scrimLive = shown && !dragging && !panelLocked;
  // Le givre n'existe dans l'arbre QUE pendant la glissade (et le temps de
  // sa transition de retour). Monté en permanence à `opacity: 0`, WebKit lui
  // appliquait quand même son `backdrop-filter` (le filtre s'applique au
  // fond avant la composition de l'élément), et sa couche sortait du clip de
  // la scène transformée : une copie floue du fil débordait autour de la
  // carte en PWA iOS, scène fermée.
  const [frostMounted, setFrostMounted] = useState(false);
  useEffect(() => {
    if (shown) {
      setFrostMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setFrostMounted(false), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);

  const value = useMemo<DrawerContextValue>(() => ({ open, setOpen, toggle }), [open, setOpen, toggle]);

  return (
    <MobileDrawerContext.Provider value={value}>
      <div
        ref={shellRef}
        data-mobile-shell=""
        data-drawer-open={open ? "" : undefined}
        className={cn("relative h-full w-full overflow-hidden bg-sidebar", className)}
        style={{ ...style, "--drawer-width": `${width}px` } as CSSProperties}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* Le panneau, statique dessous. `inert` fermé : rien n'y reçoit le
            focus tant qu'il est caché derrière la scène. */}
        <aside
          data-mobile-drawer=""
          inert={!open || panelLocked}
          aria-hidden={!open}
          className="absolute inset-y-0 left-0 flex w-(--drawer-width) flex-col overflow-hidden"
          onClickCapture={closeOnLink}
        >
          {panel}
        </aside>

        {/* La scène : la carte qui glisse. */}
        <div
          ref={sceneRef}
          data-mobile-scene=""
          className={cn(
            "absolute inset-0 flex flex-col bg-background",
            sceneLayer ? "overflow-clip" : "overflow-visible",
          )}
          style={{
            transform: sceneLayer ? `translate3d(${offset}px, 0, 0)` : "none",
            borderTopLeftRadius: shown ? SCENE_RADIUS : 0,
            borderBottomLeftRadius: shown ? SCENE_RADIUS : 0,
            boxShadow: shown ? "0 0 0 1px color-mix(in oklab, var(--border) 60%, transparent), -12px 0 32px -8px rgb(0 0 0 / 0.25)" : "none",
            transition: dragging ? "none" : `transform ${SLIDE}, border-radius ${SLIDE}, box-shadow ${SLIDE}`,
            willChange: sceneLayer ? "transform" : "auto",
          }}
          onPointerDown={!open ? beginDrag(false) : undefined}
        >
          {children}
          {/* Le givre : `backdrop-filter` sous une opacité qui suit la course,
              à pleine force dès 20 % (template : `BLUR_RAMP_END`). */}
          {frostMounted ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 backdrop-blur-md"
              style={{
                opacity: clamp(progress / BLUR_RAMP_END, 0, 1),
                backgroundColor: "color-mix(in oklab, var(--background) 35%, transparent)",
                transition: dragging ? "none" : `opacity ${SLIDE}`,
              }}
            />
          ) : null}
          {/* Le voile : la scène poussée ne se touche plus, on la ramène au
              tap ou au balayage. */}
          {shown ? (
            <button
              type="button"
              data-drawer-scrim=""
              aria-label={t("mobileShell.closeMenu")}
              aria-hidden={!scrimLive}
              tabIndex={scrimLive ? 0 : -1}
              className={cn(
                "absolute inset-0 cursor-default touch-none bg-transparent outline-none",
                !scrimLive && "pointer-events-none",
              )}
              onClick={() => {
                if (!scrimLive || ignoreClick.current) return;
                setOpen(false);
              }}
              onPointerDown={scrimLive ? beginDrag(true) : undefined}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          ) : null}
        </div>

      </div>
    </MobileDrawerContext.Provider>
  );
}
