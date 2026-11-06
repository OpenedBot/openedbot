/**
 * Asking the open thread to land on a target (`data-thread-find-target`):
 * the turn rail, the find bar and a global search hit. The thread mounts the
 * target's turn first when it is out of its mounted rows (virtual rows,
 * `use-thread-virtual-rows.ts`), so a caller never looks for it in the DOM.
 *
 * Without dependencies: `GlobalSearchFocus` is part of the first load.
 */
export const THREAD_REVEAL_EVENT = "openedbot:thread-reveal";

export type ThreadRevealDetail = { targetId: string; block?: ScrollLogicalPosition; behavior?: ScrollBehavior };

export function requestThreadReveal(targetId: string, options: Omit<ThreadRevealDetail, "targetId"> = {}) {
  document.dispatchEvent(
    new CustomEvent<ThreadRevealDetail>(THREAD_REVEAL_EVENT, { detail: { targetId, ...options } }),
  );
}
