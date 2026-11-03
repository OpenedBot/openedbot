/**
 * Aucun anneau ni bordure de focus que l'utilisateur n'a pas demandé.
 *
 * Chromium pose `:focus-visible` sur bien plus que la navigation au clavier :
 * un champ `autoFocus`, le premier élément d'une boîte de dialogue, le focus
 * rendu au déclencheur quand un menu se ferme à Échap, le retour dans la
 * fenêtre (Alt+Tab, raccourci global, clic sur l'icône du dock), un bouton
 * cliqué puis une touche. Dans tous ces cas un anneau apparaît tout seul.
 *
 * `<html>` porte `data-keyboard-focus` seulement quand une touche de
 * navigation (Tab, flèches, Début/Fin, Page) vient de DÉPLACER le focus. Tout
 * autre focus (pointeur, script, Échap, Entrée, retour dans la fenêtre)
 * le retire. Les variantes Tailwind `focus-visible:` et `focus-within:`
 * (`browser/ui-kit/src/styles/app.css`) et les règles CSS de focus exigent
 * l'attribut : sans lui, rien ne s'affiche. Tab rend l'anneau aussitôt.
 */
export const KEYBOARD_FOCUS_ATTRIBUTE = "data-keyboard-focus";

const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
]);

/** Maj+Tab navigue ; Cmd+Tab (quitter la fenêtre) ou Ctrl+flèche, non. */
function isNavigationKey(event: KeyboardEvent): boolean {
  return NAVIGATION_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** À appeler une fois au démarrage ; renvoie de quoi décrocher (tests). */
export function trackKeyboardFocus(doc: Document = document): () => void {
  const root = doc.documentElement;
  const view = doc.defaultView;
  // Le focus déplacé par la touche arrive dans la même tâche que `keydown`
  // (action par défaut de Tab, focus itinérant de Radix). Un focus posé plus
  // tard par un script ne compte plus comme navigation.
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
  // Capture : un composant qui arrête la propagation ne fait rien apparaître.
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
