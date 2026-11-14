import { useEffect, useRef, useState } from "react";

/**
 * A value that stays on screen at least `minMs` before the next one replaces
 * it, as the reference app's activity line (800 ms): a burst of tool calls otherwise
 * flashes five labels in a second and none can be read. Only the LATEST
 * pending value is kept; a value that comes back before the hold ends simply
 * stays.
 */
export function useHeldValue<T>(value: T, minMs: number): T {
  const [shown, setShown] = useState(value);
  const shownAt = useRef(Date.now());
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = shownAt.current + minMs - Date.now();
    const swap = () => {
      shownAt.current = Date.now();
      setShown(value);
    };
    if (wait <= 0) {
      swap();
      return;
    }
    const timer = window.setTimeout(swap, wait);
    return () => window.clearTimeout(timer);
  }, [value, shown, minMs]);
  return shown;
}
