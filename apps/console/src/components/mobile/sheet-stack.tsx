import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TransitionEvent as ReactTransitionEvent,
} from "react";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { clamp } from "../../lib/format";

/** Bande de bord qui arme le pop : celle d'un `UINavigationController`. */
export const SHEET_POP_EDGE = 24;
/** Au-delà, un déplacement est un balayage et non un tap. */
const DRAG_SLOP = 8;
/** Fraction de la largeur qui poppe au relâchement (sans fling). */
const POP_RATIO = 0.4;
/** Vitesse (px/ms) qui emporte la décision quand la course est incomplète. */
const FLING_VELOCITY = 0.35;
/** L'index arrive depuis la gauche, comme iOS (−28 %). */
const INDEX_PARALLAX = 0.28;
const SLIDE = "300ms cubic-bezier(0.25, 0.1, 0.25, 1)";

export const SHEET_PUSHED_SELECTOR = "[data-sheet-pushed]";

/** Le geste in-sheet gagne sur le balayage du tiroir. */
export function sheetOwnsEdgeSwipe(): boolean {
  return typeof document !== "undefined" && document.querySelector(SHEET_PUSHED_SELECTOR) !== null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  captured: boolean;
  aborted: boolean;
  lastX: number;
  lastT: number;
  velocity: number;
};

/**
 * Pile in-sheet iOS : l'index reste monté sous le panneau poussé, et un
 * balayage depuis le bord gauche poppe : comme `UINavigationController`,
 * sans toucher à l'historique. Bureau : rendu exclusif, pas de geste.
 */
export function MobileSheetStack({
  pushed,
  onPop,
  index,
  children,
}: {
  pushed: boolean;
  onPop: () => void;
  index: ReactNode;
  children?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const onPopRef = useRef(onPop);
  onPopRef.current = onPop;
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 390 : window.innerWidth));
  const [offset, setOffset] = useState<number | null>(null);
  const [settling, setSettling] = useState<"pop" | "back" | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isMobile) return;
    const sync = () => setWidth(root.getBoundingClientRect().width || window.innerWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(root);
    return () => observer.disconnect();
  }, [isMobile]);

  const finishPop = useCallback(() => {
    onPopRef.current();
    setOffset(null);
    setSettling(null);
  }, []);

  useEffect(() => {
    if (pushed) return;
    drag.current = null;
    setOffset(null);
    setSettling(null);
  }, [pushed]);

  useEffect(() => {
    if (settling === null) return;
    const timer = window.setTimeout(() => {
      if (settling === "pop") finishPop();
      else {
        setOffset(null);
        setSettling(null);
      }
    }, 360);
    return () => window.clearTimeout(timer);
  }, [settling, finishPop]);

  // iOS prend le bord gauche pour un Retour d'historique. Listener natif,
  // non passif : le même contrat que le tiroir, limité à la feuille poussée.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !isMobile || !pushed) return;
    let fromEdge = false;
    let startX = 0;
    let startY = 0;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      const left = root.getBoundingClientRect().left;
      startX = touch.clientX;
      startY = touch.clientY;
      fromEdge = startX - left <= SHEET_POP_EDGE + 4;
    };
    const onMove = (event: TouchEvent) => {
      if (!fromEdge && !drag.current?.captured) return;
      if (drag.current?.aborted) return;
      const touch = event.touches[0];
      if (touch && fromEdge && !drag.current?.captured) {
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (Math.abs(dy) > DRAG_SLOP && Math.abs(dy) > Math.abs(dx)) {
          fromEdge = false;
          return;
        }
        if (Math.abs(dx) < DRAG_SLOP) return;
      }
      if (event.cancelable) event.preventDefault();
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
    };
  }, [isMobile, pushed]);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!pushed || event.button !== 0 || !event.isPrimary) return;
    const left = event.currentTarget.getBoundingClientRect().left;
    if (event.clientX - left > SHEET_POP_EDGE) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
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
      (rootRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
    }
    const dt = Math.max(1, event.timeStamp - current.lastT);
    current.velocity = (event.clientX - current.lastX) / dt;
    current.lastX = event.clientX;
    current.lastT = event.timeStamp;
    if (prefersReducedMotion()) return;
    setOffset(clamp(dx, 0, width));
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!current.captured) {
      setOffset(null);
      return;
    }
    const dx = event.clientX - current.startX;
    const reduced = prefersReducedMotion();
    if (reduced) {
      if (dx > DRAG_SLOP) finishPop();
      return;
    }
    const position = clamp(dx, 0, width);
    const flung = current.velocity > FLING_VELOCITY;
    if (flung || position >= width * POP_RATIO) {
      setSettling("pop");
      setOffset(width);
      return;
    }
    setSettling("back");
    setOffset(0);
  };

  const onPanelTransitionEnd = (event: ReactTransitionEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") return;
    if (settling === "pop") {
      finishPop();
      return;
    }
    if (settling === "back") {
      setOffset(null);
      setSettling(null);
    }
  };

  if (!isMobile) {
    return <>{children ?? index}</>;
  }

  const dragging = offset !== null && settling === null;
  const progress = offset === null ? 0 : offset / Math.max(1, width);
  const panelX = offset ?? 0;
  const indexX = (progress - 1) * INDEX_PARALLAX * width;
  const live = pushed || settling === "pop";

  const indexStyle: CSSProperties | undefined = live
    ? {
        transform: `translate3d(${indexX}px, 0, 0)`,
        transition: dragging ? "none" : `transform ${SLIDE}`,
        willChange: "transform",
      }
    : undefined;

  const panelStyle: CSSProperties = {
    transform: `translate3d(${panelX}px, 0, 0)`,
    boxShadow: live ? "-12px 0 32px -8px rgb(0 0 0 / 0.25)" : "none",
    transition: dragging ? "none" : `transform ${SLIDE}, box-shadow ${SLIDE}`,
    willChange: "transform",
  };

  return (
    <div
      ref={rootRef}
      data-sheet-stack=""
      data-sheet-pushed={pushed ? "" : undefined}
      className="relative h-full min-h-0 flex-1 overflow-hidden"
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        data-sheet-index=""
        inert={pushed}
        aria-hidden={pushed}
        className="absolute inset-0 flex min-h-0 flex-col"
        style={indexStyle}
      >
        {index}
        {live ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundColor: `rgb(0 0 0 / ${0.12 * (1 - progress)})`,
              transition: dragging ? "none" : `background-color ${SLIDE}`,
            }}
          />
        ) : null}
      </div>
      {live ? (
        <div
          data-sheet-panel=""
          className="absolute inset-0 flex min-h-0 flex-col bg-[var(--ohb-grouped-canvas)]"
          style={panelStyle}
          onTransitionEnd={onPanelTransitionEnd}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
