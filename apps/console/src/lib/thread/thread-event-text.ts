import type { StoredProductEvent } from "@openedbot/contracts-events";
import { SUPERSEDED_NOTICE_KIND } from "@openedbot/conversation/domain/followup";

/**
 * What the timeline model (`thread-timeline-model.ts`) reads from an
 * event to render it, outside the model: the thread stream
 * (`lib/stream/live-run-text.ts`) needs it from the first load, and
 * the whole model has no business there.
 */

export function eventText(event: StoredProductEvent): string {
  const value = event.payload.text ?? event.payload.message ?? event.payload.output;
  return typeof value === "string" ? value : "";
}

/**
 * The events whose render `switch` (`thread-timeline.tsx`) does
 * NOTHING: either already rendered elsewhere (`tool.result`/`tool.result.attached` via
 * the `tool.call` chip, `approval.requested` via the gate anchored in the
 * stream, `bot.message` via `messages`), or with no display value of their own
 * (`agent.reasoning`, `raw`, `run.completed`). Exact mirror of that switch: a
 * type that gains a render there must leave here.
 */
const RENDERLESS_EVENT_TYPES = new Set<StoredProductEvent["type"]>([
  "agent.reasoning",
  "tool.result",
  "tool.result.attached",
  "approval.requested",
  // The GateCard already carries the decision. Rendered, this empty event cut
  // the turn's activity: a tool called after an approval left the block.
  "approval.responded",
  "run.completed",
  "bot.message",
  "raw",
]);

/** `system.notice` is silent ONLY for `group.pass`: the others render as a marker. */
export function rendersNothing(event: StoredProductEvent): boolean {
  return (
    RENDERLESS_EVENT_TYPES.has(event.type) ||
    (event.type === "system.notice" && (
      event.payload.kind === "group.pass" || event.payload.kind === "memory.fact"
      // A run replaced by the next message (a burst): its message stays,
      // the marker stays silent: nothing failed.
      || event.payload.kind === SUPERSEDED_NOTICE_KIND
      // Threads from before 2026-10-07: the end of a room is no longer a marker.
      || (event.payload.kind === "group.settled" && eventText(event) === "Le salon se calme.")
    ))
  );
}
