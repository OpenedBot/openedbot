/**
 * App de bureau : le champ du composer prend le focus quand un
 * fil s'ouvre et quand on revient dans la fenêtre, comme Slack ou ChatGPT
 * sur le bureau : on tape tout de suite. Navigateur et PWA n'y touchent pas
 * (au doigt, le focus ouvrirait le clavier).
 *
 * Jamais au détriment de l'utilisateur : le focus reste où il est s'il est
 * dans un champ, un menu, une liste ou une modale, si une modale est ouverte,
 * ou si du texte est sélectionné (le reprendre effacerait la sélection).
 * Au retour dans la fenêtre, il ne quitte que la navigation (rail, barre du
 * haut, barre latérale : ce qu'on vient de cliquer pour changer de fil) ;
 * une carte de gate ou l'éditeur d'agent gardent le focus clavier.
 */
const OVERLAY = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]";
const NAVIGATION = "[data-board-icon-rail],[data-board-topbar],#openedbot-board-sidebar";

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

/** Pose le focus sur le champ si rien ne s'y oppose. */
export function focusComposerField(field: HTMLTextAreaElement | null, from: "open" | "return" = "open"): void {
  if (!field || field.disabled || !field.isConnected) return;
  if (!composerMayTakeFocus(field.ownerDocument, from)) return;
  field.focus({ preventScroll: true });
}
