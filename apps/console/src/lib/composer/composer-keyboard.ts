/**
 * Geste clavier du composer : le contrat iMessage / WhatsApp / ChatGPT iOS,
 * adapté à une PWA (Safari ne redimensionne pas le layout viewport).
 *
 * Bureau (pointeur fin) : Entrée envoie, Maj+Entrée passe à la ligne.
 * Doigt : Entrée est un retour à la ligne, seul le bouton envoie. Pas de
 * Maj sur le clavier logiciel iOS : traiter Entrée comme un envoi rendait
 * le multi-ligne impossible.
 *
 * Envoi au doigt : `keepSoftKeyboard` sur Envoyer AUSSI. Sans preventDefault
 * le pointerdown blur le textarea, le clavier rentre, le bouton saute, et le
 * `click` ne part jamais : il faut retaper Envoyer. On envoie pendant que le
 * clavier est encore là, puis on blur. `+` / mic / stop : même preventDefault.
 */

/** Plafond du champ, en px. Au-delà il scrolle, le fil ne disparaît pas. */
export const COMPOSER_FIELD_MAX_PX = 200;

export function composerFieldMaxHeight(): number {
  if (typeof window === "undefined") return COMPOSER_FIELD_MAX_PX;
  return Math.min(COMPOSER_FIELD_MAX_PX, Math.round(window.innerHeight * 0.4));
}

/**
 * Fait grandir le textarea avec son contenu.
 *
 * Mesurer sans collapse (`height: auto` seul) est un no-op sur WebKit : avec
 * `overflow: auto` et une hauteur déjà posée, `scrollHeight === clientHeight`.
 * On force `0` d'abord : le contenu force alors la vraie `scrollHeight`.
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

/** Empêche le bouton de voler le focus : le clavier logiciel reste ouvert. */
export function keepSoftKeyboard(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

const THREAD_DISMISS_IGNORE =
  "a, button, input, textarea, select, [role='button'], [role='menuitem'], [data-thread-composer]";

/**
 * Tap dans le fil (pas une commande) : on relâche le composer. ChatGPT
 * ferme le clavier au tap d'une bulle ; un bouton / lien garde le focus.
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
 * Envoi au doigt : on envoie sur `pointerdown` (clavier encore ouvert),
 * pas sur `click`. `click` arrive trop tard, ou jamais, si le blur a déjà
 * fait rentrer le clavier et déplacé le bouton.
 */
export function shouldSendComposerOnPointerDown(coarsePointer: boolean): boolean {
  return coarsePointer;
}

/**
 * Ferme le clavier du composer.
 *
 * Après Envoyer, et aussi dès qu'on ouvre le drawer (swipe de bord ou
 * hamburger) : Safari garde `visualViewport` rétréci tant que le textarea
 * a le focus, et le panneau n'occupe alors que la bande au-dessus du
 * clavier. Blur tout de suite → la coque reprend 100 dvh, le roster est
 * entier.
 */
export function releaseComposerKeyboard(): void {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.hasAttribute("data-composer")) {
    active.blur();
  }
}
