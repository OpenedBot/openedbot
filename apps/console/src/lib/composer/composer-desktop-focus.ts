/**
 * Desktop app: the composer field takes focus when a
 * thread opens and when one comes back to the window, like Slack or ChatGPT
 * on the desktop: one types at once. Browser and PWA do not touch it
 * (on a finger, focus would open the keyboard).
 *
 * Never at the user's expense: focus stays where it is if it is
 * in a field, a menu, a list or a modal, if a modal is open,
 * or if text is selected (taking it back would clear the selection).
 * On return to the window, it leaves only the navigation (rail, top
 * bar, sidebar: what one just clicked to change thread);
 * a gate card or the agent editor keep keyboard focus.
 */
const OVERLAY = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]";
const NAVIGATION = "[data-board-topbar],#openedbot-board-sidebar";

export function composerMayTakeFocus(doc: Document, from: "open" | "return" = "open"): boolean {
  if (doc.querySelector('[role=dialog][data-state="open"],[role=alertdialog][data-state="open"]')) return false;
  const active = doc.activeElement;
  if (active instanceof HTMLElement && active !== doc.body) {
    if (active.closest(OVERLAY)) return false;
    if (from === "return" && !active.closest(NAVIGATION)) return false;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      active.isContentEditable
    ) return false;
  }
  const selection = doc.getSelection();
  return !selection || selection.isCollapsed;
}

/** Puts focus on the field if nothing stands in the way. */
export function focusComposerField(field: HTMLTextAreaElement | null, from: "open" | "return" = "open"): void {
  if (!field || field.disabled || !field.isConnected) return;
  if (!composerMayTakeFocus(field.ownerDocument, from)) return;
  field.focus({ preventScroll: true });
}
