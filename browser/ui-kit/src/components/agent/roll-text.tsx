import * as React from "react";
import { cn } from "../../lib/utils";
import { ShineText } from "./shine-text";

/** How long the outgoing text stays mounted: its exit lasts 140 ms. */
export const ROLL_TEXT_EXIT_MS = 180;

export type RollTextProps = {
  /** The text to show. A new value rolls in from below; the old one leaves upward. */
  value: string;
  className?: string;
  /**
   * Classes on each rolling line rather than on the slot: a shimmer
   * (`ohb-agent-label`) clips its gradient to its OWN text, so it has to sit
   * on the line that moves, not on a parent.
   */
  itemClassName?: string;
  /**
   * The working shimmer, animated with `transform` only (`ShineText`). Prefer
   * it to `itemClassName="ohb-agent-label"`, which repaints every frame.
   */
  shimmer?: boolean;
};

/**
 * A text slot whose value swaps by rolling, as `rollSlot()` in the Stream
 * collection of streaming-ui.pulseview.app: the outgoing line leaves upward
 * through a 3 px blur in 140 ms, the incoming one rises from below in 320 ms
 * on a soft spring. Both lines share one grid cell, so the slot never changes
 * height and the thread never jumps.
 *
 * The first value never animates: only a CHANGE rolls. Under
 * `prefers-reduced-motion` the swap is instant (`app.css`).
 */
export function RollText({ value, className, itemClassName, shimmer }: RollTextProps) {
  const [state, setState] = React.useState<{ current: string; previous: string | null; generation: number }>(
    () => ({ current: value, previous: null, generation: 0 }),
  );
  // Derived state, updated during render: the new value is painted in the
  // same commit as the prop change, never one frame later.
  if (state.current !== value) {
    setState({ current: value, previous: state.current, generation: state.generation + 1 });
  }
  const { previous, generation } = state;
  React.useEffect(() => {
    if (previous === null) return;
    const timer = window.setTimeout(() => {
      setState((latest) => (latest.generation === generation ? { ...latest, previous: null } : latest));
    }, ROLL_TEXT_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [previous, generation]);

  return (
    <span data-roll-text="" className={cn("ohb-roll", className)}>
      {previous !== null ? (
        <span key={`out:${generation}`} aria-hidden="true" data-roll-out="" className={cn("ohb-roll-line ohb-roll-out", itemClassName)}>
          {shimmer ? <ShineText>{previous}</ShineText> : previous}
        </span>
      ) : null}
      <span
        key={`in:${generation}`}
        data-roll-in={generation > 0 ? "" : undefined}
        className={cn("ohb-roll-line", generation > 0 && "ohb-roll-in", itemClassName)}
      >
        {shimmer ? <ShineText>{state.current}</ShineText> : state.current}
      </span>
    </span>
  );
}
