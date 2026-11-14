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

/** iOS delays the synthetic `click` (~300 ms). Below that, the guard releases. */
const GHOST_CLICK_MS = 450;
/**
 * When Safari confiscates the edge gesture for ITS « Retour », the `popstate`
 * arrives only on finger up, well after the `touchcancel` it
 * sends us on taking it. The path stays held until then, or until this delay.
 */
const SWIPE_BACK_HOLD_MS = 3000;

/**
 * The mobile shell: the template's `SidebarNav` / `AssistantNav`, in the DOM.
 *
 * The same geometry as expo-router's `drawerType: 'back'`: the panel is
 * STATIC underneath, it is the scene that slides to the right to reveal it
 * (ChatGPT's behaviour on iOS). The scene is the card: its left
 * corners round while it moves; the panel stays a flat,
 * square surface. A frosted veil (`backdrop-filter`) follows the slide and
 * freezes the pushed content, like `SceneBlurOverlay`.
 *
 * The gesture: a band of `DRAWER_EDGE_WIDTH` (40 px) on the left edge
 * opens on swipe; the pushed scene closes on tap or on a swipe
 * to the left. A navigation always closes the panel: it is
 * the screen-change animation between two drawer screens.
 */
type DrawerContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

const MobileDrawerContext = createContext<DrawerContextValue | null>(null);

/** `null` outside the mobile shell: the header then knows to render its desktop version. */
export function useMobileDrawer(): DrawerContextValue | null {
  return useContext(MobileDrawerContext);
}

/** Duration and curve of the slide: those of react-native-drawer-layout on the web. */
const SLIDE_MS = 300;
const SLIDE = `${SLIDE_MS}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
/** Fraction of the travel at which the frost is at full strength (template: 0.2). */
const BLUR_RAMP_END = 0.2;
/** Radius of the card's left corners while it moves. */
const SCENE_RADIUS = 16;
/** Past that, a move is a swipe and not a tap. */
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
  /** The panel's content: the conversations sidebar. */
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
  /** The panel stays `inert` for the length of the delayed iOS click; the hamburger does not arm that. */
  const [panelLocked, setPanelLocked] = useState(false);
  const drag = useRef<Drag | null>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const ignoreClick = useRef(false);
  /**
   * Path to restore if the iOS swipe-back changes the URL. Armed from the
   * `touchstart` on the edge band, NOT at pointerup: when Safari takes
   * the gesture for its « Retour », it cuts the sequence with a `touchcancel`
   * before any `pointerup`: no drag was captured, nothing was armed,
   * and the `popstate` that followed dropped us on the previous screen (`/`).
   */
  const holdPath = useRef<string | null>(null);
  /** A `popstate` was seen while the path was held. */
  const popped = useRef(false);
  /** Last path ACTUALLY visited (see the close effect below). */
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

  /** Holds the current path until a system « Retour » declares itself. */
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

  // The `popstate` is the only reliable sign of the swipe-back: a link tapped in
  // the panel is a push, it must never be cancelled, even while held.
  useEffect(() => {
    const onPop = () => {
      if (holdPath.current !== null) popped.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Every navigation closes the panel, except the iOS swipe-back, which we cancel:
  // the hamburger does not touch it, the edge gesture does (the same band as « Retour »).
  //
  // The `lastPath` guard is what makes the effect insensitive to re-render: without
  // it, every new identity of `navigate` (and the mount itself)
  // replayed it and closed a panel nobody had touched.
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

  // Escape closes, like a dialog: the open panel is modal for the scene.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A portaled sheet (operator settings) is above: Escape
      // closes it, the drawer stays open.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // A panel link that leads where one already is does not change `pathname`:
  // closing on the click (capture, before navigation) covers that case too.
  const closeOnLink = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest("a[href]")) setOpen(false);
  };

  // The `click` follows the `pointerup` on the element under the finger. After a
  // swipe it lands on the scrim (`data-drawer-scrim`), the brand link
  // (`/`) or a roster row, hence the snap-close and the redirect
  // to the overview on a mere opening gesture.
  useEffect(() => {
    const blockGhostClick = (event: MouseEvent) => {
      if (!ignoreClick.current) return;
      // The target FIRST: consuming the guard on a click outside the panel *and*
      // outside the scrim disarmed it for the real ghost click that followed.
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

  // React sets `touchstart` as passive: `preventDefault` on the band is
  // ignored, and iOS takes the gesture for a Back. Native listener, not passive.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let fromEdge = false;
    let startX = 0;
    let startY = 0;
    const onStart = (event: TouchEvent) => {
      // A new finger closes the previous gesture: what it held is given back.
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
      // Panel open or closed: Safari can confiscate this edge for « Retour ».
      if (atEdge) holdCurrentPath();
    };
    // Sequence ended normally: only a delayed click left to cover.
    const onEnd = () => releaseHeldPath(GHOST_CLICK_MS);
    // Sequence confiscated (Safari « Retour »): the `popstate` will come on
    // finger up, one does not know when.
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

  // Radix menus (the operator menu) are portaled out of the panel: a
  // destination chosen there does not go through `closeOnLink`.
  //
  // `[data-closes-drawer]` and NOT `[role="menuitem"]`: every Radix item carries
  // that role, including those that do not navigate: pinning a bot, toggling
  // the theme, opening the « Nouveau groupe » sheet. The panel then closed
  // under a gesture that did not change screen, and the sheet
  // opened on a scene whose drawer had just disappeared. Only the
  // items that lead elsewhere carry the attribute (see `account-menu.tsx`).
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
      // After the slop only: a tap on the scrim must still close.
      (shellRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
      // During the swipe, not at the end: otherwise the keyboard stays and the
      // visualViewport stays shrunk until pointerup.
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
  // At rest, no `translate3d(0,0,0)` and no `will-change: transform`.
  // Both make the scene a transformed ancestor even with the drawer closed:
  // in the iOS PWA, WebKit then paints the filter (and the status bar
  // `black-translucent`) on the header, not on the content that scrolls.
  // The layer stays for the length of the return slide, then it drops.
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
  // During the swipe, and 450 ms after a gesture open: the scrim
  // exists visually but receives neither click nor pointer. The hamburger
  // does not arm panelLocked → immediate tap-to-close unchanged.
  const scrimLive = shown && !dragging && !panelLocked;
  // The frost exists in the tree ONLY during the slide (and for the length of
  // its return transition). Mounted permanently at `opacity: 0`, WebKit still
  // applied its `backdrop-filter` to it (the filter applies to the
  // background before the element's composition), and its layer escaped the clip of
  // the transformed scene: a blurred copy of the thread overflowed around the
  // card in the iOS PWA, scene closed.
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
        {/* The panel, static underneath. `inert` when closed: nothing in it receives
            focus while it is hidden behind the scene. */}
        <aside
          data-mobile-drawer=""
          inert={!open || panelLocked}
          aria-hidden={!open}
          className="absolute inset-y-0 left-0 flex w-(--drawer-width) flex-col overflow-hidden"
          onClickCapture={closeOnLink}
        >
          {panel}
        </aside>

        {/* The scene: the card that slides. */}
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
          {/* The frost: `backdrop-filter` under an opacity that follows the travel,
              at full strength from 20% (template: `BLUR_RAMP_END`). */}
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
          {/* The scrim: the pushed scene is no longer touched, one brings it back on
              tap or on swipe. */}
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
