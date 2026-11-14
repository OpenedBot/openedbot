/**
 * The composer's keyboard gesture: the iMessage / WhatsApp / ChatGPT iOS contract,
 * adapted to a PWA (Safari does not resize the layout viewport).
 *
 * Desktop (fine pointer): Enter sends, Shift+Enter breaks the line.
 * Finger: Enter is a line break, only the button sends. No
 * Shift on the iOS software keyboard: treating Enter as a send made
 * multiline impossible.
 *
 * Send on a finger: `keepSoftKeyboard` on Send TOO. Without preventDefault
 * the pointerdown blurs the textarea, the keyboard retracts, the button jumps, and the
 * `click` never fires: one has to tap Send again. We send while the
 * keyboard is still there, then blur. `+` / mic / stop: the same preventDefault.
 */

/** Field ceiling, in px. Past it, it scrolls, the thread does not disappear. */
export const COMPOSER_FIELD_MAX_PX = 200;

/**
 * The thread's desktop card ceiling: six whole 24 px lines under its 10 px
 * top padding (`thread-theme.css`). 200 cut a line in half at the top.
 */
export const COMPOSER_DESKTOP_FIELD_MAX_PX = 10 + 24 * 6;

export function composerFieldMaxHeight(ceilingPx: number = COMPOSER_FIELD_MAX_PX): number {
  if (typeof window === "undefined") return ceilingPx;
  return Math.min(ceilingPx, Math.round(window.innerHeight * 0.4));
}

/**
 * The field's ceiling for this pointer. Desktop: six whole lines, then it
 * scrolls (no visible bar). Touch keeps its own ceiling: the keyboard
 * already takes half the screen.
 */
export function composerFieldCeiling(coarse: boolean): number {
  return composerFieldMaxHeight(coarse ? undefined : COMPOSER_DESKTOP_FIELD_MAX_PX);
}

/**
 * Grows the textarea with its content.
 *
 * Measuring without collapse (`height: auto` alone) is a no-op on WebKit: with
 * `overflow: auto` and a height already set, `scrollHeight === clientHeight`.
 * We force `0` first: the content then forces the real `scrollHeight`.
 */
export function resizeComposerField(
  element: { style: { height: string; overflowY: string }; scrollHeight: number },
  maxHeightPx: number,
): { height: number; scrollable: boolean } {
  element.style.height = "0px";
  const content = element.scrollHeight;
  const height = Math.min(content, maxHeightPx);
  element.style.height = `${height}px`;
  element.style.overflowY = content > maxHeightPx ? "auto" : "hidden";
  return { height, scrollable: content > maxHeightPx };
}

export function shouldSubmitComposerOnEnter(
  event: { key: string; shiftKey: boolean; nativeEvent?: { isComposing?: boolean } },
  coarsePointer: boolean,
): boolean {
  if (event.nativeEvent?.isComposing) return false;
  if (event.key !== "Enter" || event.shiftKey) return false;
  return !coarsePointer;
}

/** Stops the button from stealing focus: the software keyboard stays open. */
export function keepSoftKeyboard(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

const THREAD_DISMISS_IGNORE =
  "a, button, input, textarea, select, [role='button'], [role='menuitem'], [data-thread-composer]";

/**
 * Tap in the thread (not a command): we release the composer. ChatGPT
 * closes the keyboard on a bubble tap; a button / link keeps focus.
 */
export function dismissComposerKeyboardFromThread(event: { target: EventTarget | null }): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(THREAD_DISMISS_IGNORE)) return;
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.hasAttribute("data-composer")) {
    active.blur();
  }
}

/**
 * Send on a finger: we send on `pointerdown` (keyboard still open),
 * not on `click`. `click` arrives too late, or never, if the blur has already
 * retracted the keyboard and moved the button.
 */
export function shouldSendComposerOnPointerDown(coarsePointer: boolean): boolean {
  return coarsePointer;
}

/**
 * Closes the composer's keyboard.
 *
 * After Send, and also as soon as the drawer opens (edge swipe or
 * hamburger): Safari keeps `visualViewport` shrunk as long as the textarea
 * has focus, and the panel then occupies only the band above the
 * keyboard. Blur at once → the shell takes back 100 dvh, the roster is
 * whole.
 */
export function releaseComposerKeyboard(): void {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.hasAttribute("data-composer")) {
    active.blur();
  }
}
