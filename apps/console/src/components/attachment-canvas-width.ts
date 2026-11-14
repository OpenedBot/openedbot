import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * The canvas width is set by hand: a handle on its edge, on the
 * thread side. `null` = the default width (`ATTACHMENT_CANVAS_WIDTH`), the one
 * a double-click on the handle restores. The setting survives a
 * reload: it is a screen preference, not thread state.
 */
export const CANVAS_MIN_WIDTH = 320;
/** What the thread keeps at least beside the canvas: a usable composer. */
export const CANVAS_THREAD_MIN_WIDTH = 360;
const CANVAS_KEY_STEP = 32;
const CANVAS_WIDTH_KEY = "openedbot:attachment-canvas-width";

/** The clamped width: never under the minimum, never so far as to crush the thread. */
export function clampCanvasWidth(width: number, rowWidth: number | null): number {
  const max = rowWidth === null ? Number.POSITIVE_INFINITY : Math.max(CANVAS_MIN_WIDTH, rowWidth - CANVAS_THREAD_MIN_WIDTH);
  return Math.round(Math.min(Math.max(width, CANVAS_MIN_WIDTH), max));
}

/** The stored width, or `null`: nothing stored, unreadable value, or storage unavailable. */
export function readCanvasWidth(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(CANVAS_WIDTH_KEY);
    if (raw == null) return null;
    const width = Number(raw);
    return Number.isFinite(width) && width >= CANVAS_MIN_WIDTH ? Math.round(width) : null;
  } catch {
    // Storage refused (private browsing, profile policy): the default
    // width, and the setting lives for the session.
    return null;
  }
}

export function writeCanvasWidth(width: number | null): void {
  try {
    if (width === null) globalThis.localStorage?.removeItem(CANVAS_WIDTH_KEY);
    else globalThis.localStorage?.setItem(CANVAS_WIDTH_KEY, String(width));
  } catch {
    // Same case as the read: nothing to store, nothing broken.
  }
}

/** The canvas's current width on its scene, read by `boardui.css`. */
export const CANVAS_WIDTH_PROPERTY = "--attachment-canvas-width";

/**
 * The canvas handle: drag, arrows, Home/End, Enter (default
 * width). `mounted` restarts observation of the row when the panel
 * appears; `isMobile` stops it (the panel takes the whole screen there).
 */
export function useCanvasResize(isMobile: boolean, mounted: boolean) {
  // The width set on the handle, bounded by the row that holds the thread:
  // a shrinking window must not push the thread under its minimum.
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
  // The floating header (`BoardTopBar` surface, rail shell) overlays the
  // whole scene: it reads the canvas width so its centred title and its
  // actions stay over the thread instead of the panel. Every frame of the
  // fold and of a drag is followed; the property goes with the panel.
  useEffect(() => {
    const aside = asideRef.current;
    const scene = aside?.closest<HTMLElement>("[data-board-floating-thread]");
    if (isMobile || !aside || !scene || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      scene.style.setProperty(CANVAS_WIDTH_PROPERTY, `${aside.getBoundingClientRect().width}px`);
    });
    observer.observe(aside);
    return () => {
      observer.disconnect();
      scene.style.removeProperty(CANVAS_WIDTH_PROPERTY);
    };
  }, [isMobile, mounted]);
  // Stored on release, not on every pixel of the drag.
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
    // The handle is on the thread side: on the left in LTR, where pulling left
    // widens; on the right in RTL, where it is the reverse.
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
