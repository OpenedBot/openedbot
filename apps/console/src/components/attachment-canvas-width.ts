import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * La largeur du canevas se règle à la main : une poignée sur son bord, côté
 * fil. `null` = la largeur par défaut (`ATTACHMENT_CANVAS_WIDTH`), celle
 * qu'un double-clic sur la poignée rétablit. Le réglage survit au
 * rechargement : c'est une préférence d'écran, pas un état du fil.
 */
export const CANVAS_MIN_WIDTH = 320;
/** Ce que le fil garde au moins à côté du canevas : un composer utilisable. */
export const CANVAS_THREAD_MIN_WIDTH = 360;
const CANVAS_KEY_STEP = 32;
const CANVAS_WIDTH_KEY = "openedbot:attachment-canvas-width";

/** La largeur bornée : jamais sous le minimum, jamais au point d'écraser le fil. */
export function clampCanvasWidth(width: number, rowWidth: number | null): number {
  const max = rowWidth === null ? Number.POSITIVE_INFINITY : Math.max(CANVAS_MIN_WIDTH, rowWidth - CANVAS_THREAD_MIN_WIDTH);
  return Math.round(Math.min(Math.max(width, CANVAS_MIN_WIDTH), max));
}

/** La largeur mémorisée, ou `null` : rien de stocké, valeur illisible, ou stockage indisponible. */
export function readCanvasWidth(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(CANVAS_WIDTH_KEY);
    if (raw == null) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width >= CANVAS_MIN_WIDTH ? Math.round(width) : null;
  } catch {
    // Stockage refusé (navigation privée, politique du profil) : la largeur
    // par défaut, et le réglage vit le temps de la session.
    return null;
  }
}

export function writeCanvasWidth(width: number | null): void {
  try {
    if (width === null) globalThis.localStorage?.removeItem(CANVAS_WIDTH_KEY);
    else globalThis.localStorage?.setItem(CANVAS_WIDTH_KEY, String(width));
  } catch {
    // Même cas que la lecture : rien à mémoriser, rien de cassé.
  }
}

/**
 * La poignée du canevas : glisser, flèches, Début/Fin, Entrée (largeur par
 * défaut). `mounted` relance l'observation de la rangée quand le panneau
 * apparaît ; `isMobile` la coupe (le panneau y prend tout l'écran).
 */
export function useCanvasResize(isMobile: boolean, mounted: boolean) {
  // La largeur réglée à la poignée, bornée par la rangée qui contient le fil :
  // la fenêtre qui rétrécit ne doit pas pousser le fil sous son minimum.
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(readCanvasWidth);
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; sign: 1 | -1 } | null>(null);
  useEffect(() => {
    const row = asideRef.current?.parentElement;
    if (isMobile || !row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRowWidth(entry.contentRect.width);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [isMobile, mounted]);
  // Mémorisée au lâcher, pas à chaque pixel du glisser.
  useEffect(() => {
    if (!resizing) writeCanvasWidth(width);
  }, [resizing, width]);
  const shownWidth = !isMobile && width !== null ? clampCanvasWidth(width, rowWidth) : null;
  const maxWidth = rowWidth === null ? undefined : Math.max(CANVAS_MIN_WIDTH, rowWidth - CANVAS_THREAD_MIN_WIDTH);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const aside = asideRef.current;
    if (event.button !== 0 || !aside) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // La poignée est côté fil : à gauche en LTR, où tirer vers la gauche
    // élargit ; à droite en RTL, où c'est l'inverse.
    const sign = getComputedStyle(aside).direction === "rtl" ? -1 : 1;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: aside.getBoundingClientRect().width, sign };
    setResizing(true);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setWidth(clampCanvasWidth(current.startWidth + current.sign * (current.startX - event.clientX), rowWidth));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
  };
  const keyResize = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const aside = asideRef.current;
    if (!aside) return;
    const rtl = getComputedStyle(aside).direction === "rtl";
    const base = aside.getBoundingClientRect().width;
    const wider = rtl ? "ArrowRight" : "ArrowLeft";
    const narrower = rtl ? "ArrowLeft" : "ArrowRight";
    let next: number | null | undefined;
    if (event.key === wider) next = base + CANVAS_KEY_STEP;
    else if (event.key === narrower) next = base - CANVAS_KEY_STEP;
    else if (event.key === "Home") next = CANVAS_MIN_WIDTH;
    else if (event.key === "End") next = maxWidth ?? base;
    else if (event.key === "Enter") next = null;
    if (next === undefined) return;
    event.preventDefault();
    setWidth(next === null ? null : clampCanvasWidth(next, rowWidth));
  };
  return {
    asideRef,
    resizing,
    shownWidth,
    maxWidth,
    width,
    resetWidth: () => setWidth(null),
    startResize,
    moveResize,
    endResize,
    keyResize,
  };
}
