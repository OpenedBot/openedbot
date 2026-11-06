/**
 * App de bureau : aucun anneau, contour ni bordure de focus, même au clavier
 * (demande du 06-11-2026). Le focus lui-même ne change pas : ordre de Tab,
 * `autoFocus`, focus initial des dialogues sur leur bouton principal.
 *
 * Le web garde son comportement (`lib/shell/keyboard-focus.ts` : l'anneau
 * revient à la navigation au clavier). Dans le build desktop, `main.tsx`
 * n'installe pas ce suivi : `<html>` ne porte jamais `data-keyboard-focus`,
 * donc les variantes Tailwind `focus-visible:` / `focus-within:` (redéfinies
 * dans `browser/ui-kit`) et les règles CSS de focus qui l'exigent ne
 * s'appliquent plus. Restent les règles qui ne l'attendent pas : le contour
 * natif de WebKit et la bordure du composer au focus (`thread-theme.css`),
 * neutralisés par la feuille ci-dessous.
 *
 * Une chaîne et non un fichier CSS du bundle : le build web écarte ce module
 * dès la compilation (`VITE_OPENEDBOT_SHELL`), sa feuille ne s'y trouve pas.
 */
export const DESKTOP_FOCUS_STYLE_ATTRIBUTE = "data-openedbot-desktop-focus";

export const DESKTOP_FOCUS_CSS = `
:root :is(:focus, :focus-visible, :focus-within) {
  outline: none !important;
}
@media (min-width: 40rem) {
  :root [data-thread-column] [data-composer-shell]:focus-within {
    border-color: var(--grok-line);
  }
}
`;

/** Pose la feuille une fois, avant le premier rendu (idempotent). */
export function hideFocusRings(doc: Document = document): void {
  if (doc.head.querySelector(`style[${DESKTOP_FOCUS_STYLE_ATTRIBUTE}]`)) return;
  const style = doc.createElement("style");
  style.setAttribute(DESKTOP_FOCUS_STYLE_ATTRIBUTE, "");
  style.textContent = DESKTOP_FOCUS_CSS;
  doc.head.append(style);
}
