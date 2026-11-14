/**
 * Anchoring the thread on the composer: the assistant-ui / ChatGPT contract.
 *
 * The viewport (`role="log"`) scrolls. The message column is at least
 * 100% of its height and `justify-end`: a short thread sits against the
 * composer, not at the top of the screen. A long thread overflows upward, the
 * existing scroll-to-bottom keeps sticking the last turn.
 *
 * Measured on https://www.assistant-ui.com/ (playground): after « Envoyer », the
 * user bubble appears immediately above the input. Without an outgoing
 * message (optimistic), one waited for the refetch and the text stayed in the
 * composer: the opposite of the native gesture.
 */

/**
 * `overflow-anchor: none` on the column stops the browser from anchoring a
 * middle bubble when an image decodes. The thread's ResizeObserver keeps the
 * bottom visible for as long as the reader is pinned.
 */
export const THREAD_MESSAGES_CLASS =
  "flex min-h-full w-full flex-col justify-end gap-3 md:justify-start [overflow-anchor:none]";

/** The `gap-3` spacing of `THREAD_MESSAGES_CLASS` (12 px, the BoardUI template's `mt-3`), which a trace's trunk crosses. */
export const THREAD_ENTRY_GAP_PX = 12;

export const THREAD_SCROLL_ANCHOR_CLASS =
  "h-px w-full shrink-0 [overflow-anchor:auto]";

/** "Almost at the bottom" margin: wheel / finger, not the retina sub-pixel clip. */
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
 * assistant-ui #4141: the pin releases only on a user scroll-up
 * while the box is stable. An image that decodes grows
 * `scrollHeight` and fires `scroll`: that is not a gesture, the pin holds.
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
 * Adds the in-flight turn if it is not already in the snapshot (refetch race).
 * With no in-flight send, returns the input array (same identity): a copy
 * would break `ThreadTimeline`'s `memo` on every parent render.
 */
export function withOutgoingUserInput<T extends { id: string; text: string }>(
  inputs: readonly T[],
  outgoing: T | null,
): readonly T[] {
  if (!outgoing) return inputs;
  if (threadContainsOutgoingUserInput(inputs, outgoing)) return inputs;
  return [...inputs, outgoing];
}
