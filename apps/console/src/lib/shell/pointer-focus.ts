/**
 * Pas d'anneau de focus sur un bouton cliqué, même après une touche.
 *
 * Toute la console trace l'anneau sur `:focus-visible`, que Chromium ne pose
 * pas au clic. Mais un bouton cliqué garde le focus, et la première touche
 * qui suit (Échap pour fermer les réglages ouverts depuis le rail, Maj, une
 * lettre) le fait passer en `:focus-visible` sans que le focus ait bougé :
 * l'anneau apparaît sur un bouton que personne ne parcourt au clavier.
 *
 * `<html>` porte `data-pointer-focus` depuis le dernier appui du pointeur
 * (souris, doigt, stylet) jusqu'à ce qu'une touche DÉPLACE le focus (Tab,
 * flèches, focus rendu par un menu fermé à Échap). Tant qu'il est là,
 * `styles/components/pointer-focus.css` efface l'anneau ; au clavier seul,
 * l'attribut n'est jamais posé et rien ne change.
 */
export const POINTER_FOCUS_ATTRIBUTE = "data-pointer-focus";

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "CapsLock", "Fn"]);

/**
 * Une touche seule ou un raccourci (Cmd+Tab pour quitter la fenêtre, Cmd+K)
 * ne parcourt pas la page : le focus rendu au retour reste « pointeur ».
 */
function isNavigationKey(event: KeyboardEvent): boolean {
  return !MODIFIER_KEYS.has(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/** À appeler une fois au démarrage ; renvoie de quoi décrocher (tests). */
export function trackPointerFocus(doc: Document = document): () => void {
  const root = doc.documentElement;
  let keyboard = false;
  const onPointerDown = () => {
    keyboard = false;
    root.setAttribute(POINTER_FOCUS_ATTRIBUTE, "");
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isNavigationKey(event)) keyboard = true;
  };
  const onFocusIn = () => {
    if (keyboard) root.removeAttribute(POINTER_FOCUS_ATTRIBUTE);
  };
  // Capture : un composant qui arrête la propagation ne cache rien.
  doc.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    root.removeAttribute(POINTER_FOCUS_ATTRIBUTE);
  };
}
