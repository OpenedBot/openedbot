/**
 * No focus ring or border the user did not ask for.
 *
 * Chromium sets `:focus-visible` on much more than keyboard navigation:
 * an `autoFocus` field, the first element of a dialog, the focus
 * returned to the trigger when a menu closes on Escape, returning to the
 * window (Alt+Tab, global shortcut, click on the dock icon), a button
 * clicked then a key. In all those cases a ring appears on its own.
 *
 * `<html>` carries `data-keyboard-focus` only when a navigation
 * key (Tab, arrows, Home/End, Page) has just MOVED the focus. Any
 * other focus (pointer, script, Escape, Enter, returning to the window)
 * removes it. The Tailwind variants `focus-visible:` and `focus-within:`
 * (`browser/ui-kit/src/styles/app.css`) and the focus CSS rules require
 * the attribute: without it, nothing is shown. Tab shows the ring at once.
 */
export const KEYBOARD_FOCUS_ATTRIBUTE = "data-keyboard-focus";

const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
]);

/** Shift+Tab navigates; Cmd+Tab (leave the window) or Ctrl+arrow does not. */
function isNavigationKey(event: KeyboardEvent): boolean {
  return NAVIGATION_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** Call once at startup; returns what unhooks it (tests). */
export function trackKeyboardFocus(doc: Document = document): () => void {
  const root = doc.documentElement;
  const view = doc.defaultView;
  // The focus moved by the key arrives in the same task as `keydown`
  // (Tab's default action, Radix roving focus). A focus set later
  // by a script no longer counts as navigation.
  let navigating = false;
  let reset: ReturnType<typeof setTimeout> | undefined;
  const stopNavigating = () => {
    navigating = false;
    if (reset !== undefined) clearTimeout(reset);
    reset = undefined;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    stopNavigating();
    if (!isNavigationKey(event)) return;
    navigating = true;
    reset = (view ?? globalThis).setTimeout(stopNavigating, 0);
  };
  const onFocusIn = () => {
    if (navigating) root.setAttribute(KEYBOARD_FOCUS_ATTRIBUTE, "");
    else root.removeAttribute(KEYBOARD_FOCUS_ATTRIBUTE);
  };
  const onPointerDown = () => {
    stopNavigating();
    root.removeAttribute(KEYBOARD_FOCUS_ATTRIBUTE);
  };
  // Capture: a component that stops propagation makes nothing appear.
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  return () => {
    stopNavigating();
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    root.removeAttribute(KEYBOARD_FOCUS_ATTRIBUTE);
  };
}
