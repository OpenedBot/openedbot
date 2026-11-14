/**
 * Desktop app: no ring, outline or focus border, even from the keyboard
 * (request of 06-11-2026). Focus itself does not change: Tab order,
 * `autoFocus`, dialogs' initial focus on their primary button.
 *
 * The web keeps its behavior (`lib/shell/keyboard-focus.ts`: the ring
 * comes back for keyboard navigation). In the desktop build, `main.tsx`
 * does not install that tracking: `<html>` never carries `data-keyboard-focus`,
 * so the Tailwind `focus-visible:` / `focus-within:` variants (redefined
 * in `browser/ui-kit`) and the focus CSS rules that require it no longer
 * apply. What remains are the rules that do not expect it: WebKit's native
 * outline and the composer's border on focus (`thread-theme.css`),
 * neutralized by the sheet below.
 *
 * A string and not a CSS file of the bundle: the web build drops this module
 * at compile time (`VITE_OPENEDBOT_SHELL`), so its sheet is not there.
 */
export const DESKTOP_FOCUS_STYLE_ATTRIBUTE = "data-openedbot-desktop-focus";

export const DESKTOP_FOCUS_CSS = `
:root :is(:focus, :focus-visible, :focus-within) {
  outline: none !important;
}
@media (min-width: 40rem) {
  :root [data-thread-column] [data-composer-shell]:focus-within {
    border-color: var(--stream-line);
  }
}
`;

/** Installs the sheet once, before the first render (idempotent). */
export function hideFocusRings(doc: Document = document): void {
  if (doc.head.querySelector(`style[${DESKTOP_FOCUS_STYLE_ATTRIBUTE}]`)) return;
  const style = doc.createElement("style");
  style.setAttribute(DESKTOP_FOCUS_STYLE_ATTRIBUTE, "");
  style.textContent = DESKTOP_FOCUS_CSS;
  doc.head.append(style);
}
