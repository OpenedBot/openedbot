import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * The motion of the thread and the composer, taken from the reference app 0.78.1 on 30-10
 * (frame-by-frame capture of a real send, `reports/reference-app/2026_10_30`).
 * The values are its own; the style sheets reuse the same ones
 * (`thread-timeline.css`, `agent-activity.css`).
 */

/** the reference app's spring (composer pill → card, 300 ms): a sampled `linear()`. */
export const STREAM_SPRING =
  "linear(0 0%, 0.01588 2%, 0.05618 4%, 0.11201 6%, 0.1768 8%, 0.2458 10%, 0.31562 12%, 0.38392 14%, 0.44914 16%, 0.51029 18%, 0.56683 20%, 0.61852 22%, 0.66534 24%, 0.70743 26%, 0.74501 28%, 0.77838 30%, 0.80788 32%, 0.83383 34%, 0.85658 36%, 0.87645 38%, 0.89376 40%, 0.92183 44%, 0.94282 48%, 0.95838 52%, 0.96984 56%, 0.97823 60%, 0.98435 64%, 0.98878 68%, 0.99198 72%, 0.99594 80%, 0.99829 90%, 1 100%)";
export const STREAM_SPRING_MS = 300;

/** An arriving message rises by 12 px, with no fade: 240 ms. */
export const ROW_ENTER_MS = 240;
export const ROW_ENTER_EASING = "cubic-bezier(0.23, 1, 0.32, 1)";
export const ROW_ENTER_OFFSET_PX = 12;

/** The activity mark that leaves: scale 0.92 and fade, 140 ms (`bubbleExiting`). */
export const TYPING_EXIT_MS = 140;

/** What follows an added row without making it an addition "in the middle". */
const TRAILING_CHROME = "[data-thread-scroll-anchor], [data-thread-outgoing], [data-thread-exit-ghost]";
/** A turn's row (`use-thread-virtual-rows.ts`). */
const TURN_ROW = "data-thread-turn";
/** A message row; a date separator or a marker does not animate. */
const MESSAGE_ROW = "[data-user-bubble], [data-assistant-layout], [data-assistant-response], [data-room-answer], [data-inbound-from]";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function isMessageRow(node: Element): boolean {
  return node.matches(MESSAGE_ROW) || node.querySelector(MESSAGE_ROW) !== null;
}

function userBubbleText(node: Element): string | null {
  const bubble = node.matches("[data-user-bubble]") ? node : node.querySelector("[data-user-bubble]");
  return bubble ? (bubble.textContent ?? "").trim() : null;
}

/**
 * Makes every message added AT THE END of the thread rise (send, answer), like
 * The reference app. At the DOM level, not the render: turns are cached
 * (`turnNodeCache`), and a "new" flag in their props would invalidate
 * that cache.
 *
 * These do not move:
 * - a thread's first render (the observer arrives after it) and a
 *   thread change (`threadKey`, the observer is rearmed);
 * - older history, added BEFORE rows already there;
 * - the saved row that replaces the optimistic bubble
 *   (`data-thread-outgoing`): same text, the bubble already rose;
 * - a turn remounted by scrolling (`data-thread-turn` already seen, virtual
 *   rows): it does not arrive, it comes back.
 *
 * A turn's messages live in its row (`data-thread-turn`): a
 * new turn makes its messages rise, an answer added to the last turn's
 * row rises alone.
 */
export function useThreadRowEnter(content: RefObject<HTMLElement | null>, threadKey: string | null) {
  useEffect(() => {
    const root = content.current;
    if (!root || typeof MutationObserver === "undefined" || prefersReducedMotion()) return;
    // The text of the last optimistic bubble seen: its replacement does not replay.
    let outgoingText: string | null = null;
    let outgoingAt = 0;
    // Negative `delay`: the entry resumes where it is, instead of starting again from 12 px.
    const rise = (row: Element, delay = 0) => {
      if (typeof (row as HTMLElement).animate !== "function") return;
      (row as HTMLElement).animate(
        [{ transform: `translateY(${ROW_ENTER_OFFSET_PX}px)` }, { transform: "none" }],
        { duration: ROW_ENTER_MS, easing: ROW_ENTER_EASING, delay },
      );
    };
    const seenTurns = new Set<string>();
    for (const turn of root.querySelectorAll(`:scope > [${TURN_ROW}]`)) seenTurns.add(turn.getAttribute(TURN_ROW)!);
    const isLast = (node: Element, added: ReadonlySet<Element>) => {
      for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
        if (!added.has(next) && !next.matches(TRAILING_CHROME)) return false;
      }
      return true;
    };
    const observer = new MutationObserver((records) => {
      const added = new Set<Element>();
      // What arrived: a direct child, or a message added to a turn's row.
      // A new turn row stands for its messages; a row seen before is a
      // virtual row mounted back by scrolling, not an arrival.
      const candidates: Element[] = [];
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) added.add(node);
      }
      for (const node of added) {
        const parent = node.parentElement;
        const turn = node.getAttribute(TURN_ROW);
        if (parent === root && turn !== null) {
          const fresh = !seenTurns.has(turn);
          seenTurns.add(turn);
          if (fresh && isLast(node, added)) candidates.push(...node.children);
          continue;
        }
        if (parent === root) candidates.push(node);
        else if (parent?.parentElement === root && parent.hasAttribute(TURN_ROW) && !added.has(parent) && isLast(parent, added)) candidates.push(node);
      }
      for (const node of candidates) {
        if (!isLast(node, added) && !added.has(node.parentElement!)) continue;
        if (!isMessageRow(node)) continue;
        const text = userBubbleText(node);
        if (node.matches("[data-thread-outgoing]")) {
          outgoingText = text;
          outgoingAt = performance.now();
        } else if (text !== null && text === outgoingText) {
          outgoingText = null;
          // Saved in the middle of the optimistic bubble's rise, the row (and the
          // « Réflexion » line that arrived with it) finishes that rise: otherwise
          // the rest, a few pixels, dropped all at once.
          const elapsed = performance.now() - outgoingAt;
          if (elapsed < ROW_ENTER_MS) {
            for (const row of [node, ...[...added].filter((other) => other.matches("[data-thread-thinking]"))]) rise(row, -elapsed);
          }
          continue;
        }
        rise(node);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [content, threadKey]);
}

/**
 * A mark that leaves the thread fades instead of vanishing at once:
 * on unmount, its inert copy takes its place for the time of the reference app's
 * exit. The row that replaces it enters during that time, in the same place.
 *
 * The copy stays in the flow (the list is not positioned: absolutely,
 * it would land outside the scroll) but occupies nothing there: its bottom margin
 * gives back its height, its top margin and the list's gap.
 *
 * A layout effect's cleanup runs before the node is removed:
 * it is still in place, its size and its previous sibling are read there. The
 * copy enters only one microtask later, if the node really left
 * the DOM: `StrictMode`'s double mount (dev) cleans up then remounts in
 * place, without removing anything.
 */
export function useExitGhost(node: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = node.current;
    return () => {
      const parent = element?.parentElement;
      if (!element || !parent || !element.isConnected || prefersReducedMotion()) return;
      if (typeof element.animate !== "function") return;
      const marginTop = Number.parseFloat(getComputedStyle(element).marginTop) || 0;
      const gap = Number.parseFloat(getComputedStyle(parent).rowGap) || 0;
      const height = element.offsetHeight;
      const previous = element.previousSibling;
      const next = element.nextSibling;
      const ghost = element.cloneNode(true) as HTMLElement;
      queueMicrotask(() => {
        if (element.isConnected || !parent.isConnected) return;
        ghost.setAttribute("data-thread-exit-ghost", "");
        ghost.setAttribute("aria-hidden", "true");
        ghost.removeAttribute("data-thread-thinking");
        for (const live of [ghost, ...ghost.querySelectorAll<HTMLElement>("*")]) {
          live.removeAttribute("role");
          live.removeAttribute("id");
          // The copy does not replay the original's entry.
          live.style.animation = "none";
        }
        Object.assign(ghost.style, {
          marginBottom: `${-(marginTop + height + gap)}px`,
          pointerEvents: "none",
        });
        // Just after the previous sibling: the row that replaces the mark may
        // have entered in its place, before the next sibling.
        const before = previous?.parentNode === parent
          ? previous.nextSibling
          : next?.parentNode === parent ? next : null;
        parent.insertBefore(ghost, before);
        const animation = ghost.animate(
          [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.92)" }],
          { duration: TYPING_EXIT_MS, easing: "ease", fill: "forwards" },
        );
        const remove = () => ghost.remove();
        animation.addEventListener("finish", remove, { once: true });
        animation.addEventListener("cancel", remove, { once: true });
      });
    };
  }, [node]);
}

/**
 * The composer pill that becomes a card: its height and its radius (22 → 18)
 * follow the reference app's spring instead of jumping. The content switches at once
 * to the card; the frame clips it for the time of the spring.
 */
export function animateComposerExpand(frame: HTMLElement, from: { height: number; radius: string }) {
  if (prefersReducedMotion() || typeof frame.animate !== "function") return;
  const toHeight = frame.getBoundingClientRect().height;
  if (!from.height || Math.abs(toHeight - from.height) < 1) return;
  const toRadius = getComputedStyle(frame).borderRadius;
  const previousOverflow = frame.style.overflow;
  frame.style.overflow = "clip";
  const animation = frame.animate(
    [
      { height: `${from.height}px`, borderRadius: from.radius || toRadius },
      { height: `${toHeight}px`, borderRadius: toRadius },
    ],
    { duration: STREAM_SPRING_MS, easing: STREAM_SPRING },
  );
  const restore = () => {
    frame.style.overflow = previousOverflow;
  };
  animation.addEventListener("finish", restore, { once: true });
  animation.addEventListener("cancel", restore, { once: true });
}
