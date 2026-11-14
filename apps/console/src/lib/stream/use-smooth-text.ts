import { useEffect, useRef, useState } from "react";
import { TextStreamAnimator, type AnimatorIo } from "@openedbot/browser-face/text-stream-animator";

/**
 * Smoothing of streamed text, on the browser side.
 *
 * The mechanism (`TextStreamAnimator`) lives in the core, shared with
 * mobile: the pipeline delivers text in bursts (worker coalescing 100 ms +
 * SSE poller, measured: +90 to +230 characters at once), and without smoothing the
 * bubble advances in jolts on both clients. Only the React wiring
 * and the browser clock remain here.
 */
const browserIo: AnimatorIo = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
};

/** Re-exported: this module's tests drive the animator with their own clock. */
export { TextStreamAnimator };

/** Hard bound of a catch-up: concluded run, or a large block received at once. */
export const SMOOTH_CATCH_UP_MAX_MS = 300;

/**
 * Past this, an addition is no longer a stream burst (measured: +90 to +230
 * characters) but a block: the complete answer delivered at once, or a
 * snapshot catching up. It plays out within `SMOOTH_CATCH_UP_MAX_MS`.
 */
export const SMOOTH_BLOCK_CHARS = 400;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function retargetSmoothText(
  animator: TextStreamAnimator,
  text: string,
  enabled: boolean,
  previouslyStreaming: boolean,
  reduceMotion = false,
): void {
  // No animation under `prefers-reduced-motion`.
  if (reduceMotion) {
    if (animator.currentText !== text || animator.targetText !== text) animator.jumpTo(text);
    return;
  }
  if (!enabled) {
    if (previouslyStreaming && text.startsWith(animator.currentText)) {
      // Concluded run: the remaining lag catches up in a bounded time, it does not
      // add to the answer's wait.
      animator.targetText = text;
      if (animator.currentText !== text) animator.start(SMOOTH_CATCH_UP_MAX_MS);
    } else {
      animator.jumpTo(text);
    }
    return;
  }
  if (!text.startsWith(animator.targetText)) {
    animator.jumpTo(text);
    return;
  }
  const added = text.length - animator.targetText.length;
  animator.targetText = text;
  if (animator.currentText !== text) {
    animator.start(added > SMOOTH_BLOCK_CHARS ? SMOOTH_CATCH_UP_MAX_MS : undefined);
  }
}

/**
 * Renders a smoothed version of `text` for as long as `enabled` is true. A bubble
 * mounted while streaming animates from empty; mounted outside streaming (`enabled`
 * false: concluded run, historical bubble) it renders its text as-is,
 * immediately.
 */
export function useSmoothText(text: string, enabled: boolean): string {
  // A bubble that is BORN streaming starts from empty: its first fragment
  // animates too. Starting from the mounted text let the whole first burst
  // (or even a whole short answer) appear in one block, then freeze
  // ~500 ms until the next burst (measured: a pop of ~157 characters).
  // Under `prefers-reduced-motion`, the mounted text is rendered as-is.
  const [startsEmpty] = useState(() => enabled && !prefersReducedMotion());
  const [displayedText, setDisplayedText] = useState(startsEmpty ? "" : text);
  const [animator] = useState(() => new TextStreamAnimator(startsEmpty ? "" : text, setDisplayedText, browserIo));
  const wasStreaming = useRef(enabled);

  useEffect(() => {
    const previouslyStreaming = wasStreaming.current;
    wasStreaming.current = enabled;
    // `run.completed` is often delivered in the same SSE tick as the last
    // fragment. The stream -> final transition finishes its lag, but within
    // `SMOOTH_CATCH_UP_MAX_MS` at most: the answer is already there.
    retargetSmoothText(animator, text, enabled, previouslyStreaming, prefersReducedMotion());
  }, [animator, enabled, text]);

  useEffect(() => () => animator.stop(), [animator]);

  return displayedText;
}
