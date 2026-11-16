import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The motion of the thread and the composer, taken from the reference app 0.78.1 on 30-10
 * (frame-by-frame capture of a real send, `reports/reference-app/2026_10_30`).
 * The values are its own; the style sheets reuse the same ones
 * (`thread-timeline.css`, `agent-activity.css`).
 *
 * A sent message does not rise into place: the thread moves to the bottom
 * once, in the commit that inserts it (`use-thread-scroll-follow.ts`), and a
 * rise would be a second motion on that frame.
 */

/** the reference app's spring (composer pill → card, 300 ms): a sampled `linear()`. */
export const STREAM_SPRING =
  "linear(0 0%, 0.01588 2%, 0.05618 4%, 0.11201 6%, 0.1768 8%, 0.2458 10%, 0.31562 12%, 0.38392 14%, 0.44914 16%, 0.51029 18%, 0.56683 20%, 0.61852 22%, 0.66534 24%, 0.70743 26%, 0.74501 28%, 0.77838 30%, 0.80788 32%, 0.83383 34%, 0.85658 36%, 0.87645 38%, 0.89376 40%, 0.92183 44%, 0.94282 48%, 0.95838 52%, 0.96984 56%, 0.97823 60%, 0.98435 64%, 0.98878 68%, 0.99198 72%, 0.99594 80%, 0.99829 90%, 1 100%)";
export const STREAM_SPRING_MS = 300;

/** The activity mark that leaves: scale 0.92 and fade, 140 ms (`bubbleExiting`). */
export const TYPING_EXIT_MS = 140;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
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
 * A run's status line entering or leaving a settled turn: height and
 * opacity over 200 ms with the stream ease (`--stream-ease`). The leaving
 * row collapses in CSS (`openedbot-run-status-collapse`, stream-motion.css).
 */
export const RUN_LINE_MOTION_MS = 200;
const STREAM_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * A line that appears above a reply already on screen (a run's summary at
 * its end, the bot's name when its first tool starts) opens from zero
 * height instead of pushing the reply down in one frame. Its negative top
 * margin hands back the turn's row gap meanwhile, so the turn grows
 * smoothly by exactly the line's final room; a pinned thread follows it
 * through its ResizeObserver. Decided once, on mount; nothing under
 * `prefers-reduced-motion`.
 */
export function useRevealOnMount(node: RefObject<HTMLElement | null>, enabled: boolean) {
  const enabledOnMount = useRef(enabled);
  useLayoutEffect(() => {
    const element = node.current;
    if (!enabledOnMount.current || !element || prefersReducedMotion() || typeof element.animate !== "function") return;
    const parent = element.parentElement;
    // The row gap only exists above a line that has a previous sibling.
    const gap = parent && element.previousElementSibling ? Number.parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
    const height = element.getBoundingClientRect().height;
    const previousOverflow = element.style.overflow;
    element.style.overflow = "clip";
    const animation = element.animate(
      [
        { height: "0px", opacity: 0, marginTop: `${-gap}px` },
        { height: `${height}px`, opacity: 1, marginTop: "0px" },
      ],
      { duration: RUN_LINE_MOTION_MS, easing: STREAM_EASE },
    );
    const restore = () => {
      element.style.overflow = previousOverflow;
    };
    animation.addEventListener("finish", restore, { once: true });
    animation.addEventListener("cancel", restore, { once: true });
    return () => animation.cancel();
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
