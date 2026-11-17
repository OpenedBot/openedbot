import { type DOMAttributes, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from "react";

/** Duration of a long press: that of `Pressable` / the iOS context menu. */
const LONG_PRESS_MS = 450;
/** Past that, the finger scrolls the list: it is no longer a press. */
const LONG_PRESS_SLOP = 10;
/** Window during which the click synthesized by the finger lifting is ignored. */
const GHOST_CLICK_MS = 700;

/**
 * The long press that replaces hover on a touch screen.
 *
 * On a phone, the hover icon row was forced visible
 * permanently: three 28 px chips stuck to EVERY bubble, which stole
 * 5.5 rem of width from the text and misaligned the column. No native
 * messenger does that: a message's actions are obtained there by holding it
 * pressed, and arrive in a sheet anchored at the bottom.
 */
export function useLongPress(onLongPress: () => void, enabled: boolean): Partial<DOMAttributes<HTMLElement>> {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  useEffect(() => clear, [clear]);

  if (!enabled) return {};

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      // The mouse keeps hover; only the finger (or the stylus) triggers it.
      if (!event.isPrimary || event.pointerType === "mouse") return;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        // The finger is still down: on lifting it, the engine synthesizes a
        // `click` at the same coordinates, which would land on the veil of the
        // sheet just mounted and close it at once. That
        // ghost click is swallowed: the same trap as iOS's « ghost click ».
        const swallow = (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
        };
        document.addEventListener("click", swallow, true);
        window.setTimeout(() => document.removeEventListener("click", swallow, true), GHOST_CLICK_MS);
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start) return;
      if (
        Math.abs(event.clientX - start.x) > LONG_PRESS_SLOP ||
        Math.abs(event.clientY - start.y) > LONG_PRESS_SLOP
      ) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    // Without that, WebKit opens ITS selection callout over the sheet.
    onContextMenu: (event) => event.preventDefault(),
  };
}
