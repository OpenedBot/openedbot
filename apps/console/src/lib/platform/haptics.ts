/**
 * « fire-and-forget » haptic feedback, on the model of `shared/lib/platform/haptics.ts`
 * from the mobile template: a no-op wherever the engine does not expose it, and
 * never an error.
 *
 * The web only has `navigator.vibrate` (Chromium Android). Safari iOS does not
 * implement it: the gesture stays silent there, as in a WebView without a native
 * module. Kept behind `pointer: coarse`: a laptop with a vibration
 * motor plugged in must not buzz under the mouse.
 */
type VibratingNavigator = Navigator & { vibrate?: (pattern: number | number[]) => boolean };

function canVibrate(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (typeof (navigator as VibratingNavigator).vibrate !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

function vibrate(pattern: number | number[]): void {
  if (!canVibrate()) return;
  try {
    (navigator as VibratingNavigator).vibrate?.(pattern);
  } catch {
    // A haptic feedback that fails is never worth an exception.
  }
}

export const haptics = {
  /** A light contact: the panel that snaps, a row that opens. */
  light: () => vibrate(8),
  /** A selection change: tab, option, segment. */
  selection: () => vibrate(4),
  /** A completed action: message sent, setting saved. */
  success: () => vibrate([6, 40, 10]),
};
