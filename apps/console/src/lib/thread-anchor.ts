/**
 * Ancrage du fil sur le composer : le contrat assistant-ui / ChatGPT.
 *
 * Le viewport (`role="log"`) scrolle. La colonne de messages fait au moins
 * 100 % de sa hauteur et `justify-end` : un fil court s'assoit contre le
 * composer, pas en haut de l'écran. Un fil long déborde vers le haut, le
 * scroll-to-bottom existant continue de coller le dernier tour.
 *
 * Mesuré sur https://www.assistant-ui.com/ (playground) : après Envoyer, la
 * bulle user apparaît immédiatement au-dessus de l'input. Sans message
 * sortant (optimistic), on attendait le refetch et le texte restait dans le
 * composer : l'inverse du geste natif.
 */

/**
 * `overflow-anchor: none` sur la colonne empêche le navigateur d'ancrer une
 * bulle du milieu quand une image décode. Le ResizeObserver du fil garde le
 * bas visible tant que le lecteur est épinglé.
 */
export const THREAD_MESSAGES_CLASS =
  "flex min-h-full w-full flex-col justify-end gap-3 md:justify-start [overflow-anchor:none]";

/** L'écart `gap-3` de `THREAD_MESSAGES_CLASS` (12 px, le `mt-3` du template BoardUI), que le tronc d'une trace traverse. */
export const THREAD_ENTRY_GAP_PX = 12;

export const THREAD_SCROLL_ANCHOR_CLASS =
  "h-px w-full shrink-0 [overflow-anchor:auto]";

/** Marge « presque en bas » : molette / doigt, pas le clip sub-pixel retina. */
export const THREAD_AT_BOTTOM_PX = 40;

export type ThreadScrollBox = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function readThreadScrollBox(node: ThreadScrollBox): ThreadScrollBox {
  return {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  };
}

export function isThreadVisuallyAtBottom(
  box: ThreadScrollBox,
  threshold = THREAD_AT_BOTTOM_PX,
): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
}

/**
 * assistant-ui #4141 : le pin ne se lâche que sur un scroll-up utilisateur
 * pendant que la boîte est stable. Une image qui décode grandit
 * `scrollHeight` et fire `scroll` : ce n'est pas un geste, le pin tient.
 * https://github.com/assistant-ui/assistant-ui/pull/4141
 */
export function nextThreadPin(
  previous: ThreadScrollBox,
  next: ThreadScrollBox,
  currentlyPinned: boolean,
): boolean {
  if (isThreadVisuallyAtBottom(next)) return true;
  const boxStable =
    previous.scrollHeight === next.scrollHeight &&
    previous.clientHeight === next.clientHeight;
  if (boxStable && previous.scrollTop > next.scrollTop) return false;
  return currentlyPinned;
}

export type ThreadUserInput = {
  id: string;
  text: string;
  runId: string | null;
  createdAt?: string;
  authorBot?: { id: string } | null;
};

export type OutgoingUserInput = {
  id: string;
  text: string;
  clientSubmissionId?: string;
  messageId?: string;
  failed?: boolean;
  attachments?: Array<{ type: "attachment"; name: string; contentType: string; kind: "image" | "document"; bytes: number }>;
};

/**
 * Only an identity acknowledgement retires an optimistic bubble. Repeated
 * text is a new message, even when it is identical to the last user input.
 */
export function threadContainsOutgoingUserInput<T extends { id: string; text: string; clientSubmissionId?: string | null }>(
  inputs: readonly T[],
  outgoing: OutgoingUserInput | null,
): boolean {
  if (!outgoing) return true;
  return inputs.some((item) => item.id === (outgoing.messageId ?? outgoing.id)
    || Boolean(outgoing.clientSubmissionId && item.clientSubmissionId === outgoing.clientSubmissionId));
}

/**
 * Ajoute le tour en vol s'il n'est pas déjà dans le snapshot (course refetch).
 * Sans envoi en vol, rend le tableau d'entrée (même identité) : une copie
 * casserait le `memo` de `ThreadTimeline` à chaque rendu parent.
 */
export function withOutgoingUserInput<T extends { id: string; text: string }>(
  inputs: readonly T[],
  outgoing: T | null,
): readonly T[] {
  if (!outgoing) return inputs;
  if (threadContainsOutgoingUserInput(inputs, outgoing)) return inputs;
  return [...inputs, outgoing];
}
