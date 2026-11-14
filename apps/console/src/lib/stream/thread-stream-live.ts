import type { StoredProductEvent } from "@openedbot/contracts-events";
import { snapshotRefreshAfterEvent } from "@openedbot/conversation/domain/thread-snapshot-mutations";

const DEDUPE_WINDOW = 1_000;

export type LiveEventIdentity = {
  organizationId: string;
  /** Absent on a fan-out before commit: it is not a resume position. */
  cursor?: number;
  runId: string;
  sequence: number;
};

export type LiveDedupe = {
  cursors: Set<number>;
  /** `(runId, sequence)` → cursor of the copy seen. */
  runSequences: Map<string, number>;
};

export function createLiveDedupe(): LiveDedupe {
  return { cursors: new Set(), runSequences: new Map() };
}

export function resetLiveDedupe(state: LiveDedupe): void {
  state.cursors.clear();
  state.runSequences.clear();
}

/**
 * Deliver this event to the screens, or ignore it.
 *
 * The bubble dedupes on `(runId, sequence)`: an early fan-out
 * then the durable replay of the same event are not added
 * twice. The resume cursor stays the log's (`event.cursor`), including
 * when the copy is already known, it is not the display key.
 */
export function acceptLiveEvent(
  state: LiveDedupe,
  event: LiveEventIdentity,
  organizationId: string,
  streamCursor: number,
): { deliver: boolean; streamCursor: number } {
  if (event.organizationId !== organizationId) return { deliver: false, streamCursor };
  const key = `${event.runId}:${event.sequence}`;
  const cursor = typeof event.cursor === "number" && Number.isSafeInteger(event.cursor) ? event.cursor : null;
  const duplicate = (cursor !== null && state.cursors.has(cursor)) || state.runSequences.has(key);
  const nextCursor = cursor !== null && cursor > streamCursor ? cursor : streamCursor;
  if (!duplicate) {
    if (cursor !== null) state.cursors.add(cursor);
    state.runSequences.set(key, cursor ?? streamCursor);
  } else if (cursor !== null) {
    const seen = state.runSequences.get(key);
    if (seen === undefined || cursor > seen) state.runSequences.set(key, cursor);
    state.cursors.add(cursor);
  }
  const floor = nextCursor - DEDUPE_WINDOW;
  for (const seen of state.cursors) if (seen < floor) state.cursors.delete(seen);
  for (const [seenKey, seenCursor] of state.runSequences) {
    if (seenCursor < floor) state.runSequences.delete(seenKey);
  }
  return { deliver: !duplicate, streamCursor: nextCursor };
}

/** `stream.cursor`: the open thread may stay quiet, the resume still advances. */
export function advanceStreamCursor(current: number, cursor: number): number {
  return Number.isSafeInteger(cursor) && cursor > current ? cursor : current;
}

/**
 * Reconnect of the singleton (Bun idleTimeout, network).
 *
 * No GET if resume is at the cursor inside the replay window. The GET is
 * owed only when an already open stream has passed this screen's snapshot
 * (events consumed before the subscription). A `stream.gap` is handled apart.
 */
export function refetchOnStreamOpen(mayHaveMissed: boolean): { thread: boolean; roster: boolean } {
  return mayHaveMissed ? { thread: true, roster: true } : { thread: false, roster: false };
}

/**
 * GET after the patch.
 *
 * A delta of a run already present is patched in place. It is reread only if the
 * run is still absent after application.
 *
 * Gap: `ProductEventType` has no `run.created`. A delta's payload
 * carries no `RunDto` (`input`, `createdAt`, `hermesResponseId`).
 * `applyProductEventToSnapshot` therefore inserts no row. Those fields are not
 * invented: an absent run stays absent, and it is reread.
 *
 * The `message.admitted` receipt of a message the snapshot already has (this
 * tab's 202 placed it, with its run) teaches nothing: it arrives with the
 * run's first event, and rereading it cost a `GET /history` in the
 * middle of the stream. An unknown message (another tab, another device)
 * is still reread.
 */
export function refreshAfterAppliedEvent(input: {
  event: StoredProductEvent;
  hadSnapshot: boolean;
  snapshotAfter: { runs: readonly { id: string }[]; messages?: readonly { id: string }[] } | undefined;
  snapshotCursorBefore: number | undefined;
}): { thread: boolean; roster: boolean } {
  const unknownRun = input.hadSnapshot
    && input.snapshotAfter !== undefined
    && !input.snapshotAfter.runs.some((run) => run.id === input.event.runId);
  if (!unknownRun && isKnownAdmission(input.event, input.snapshotAfter?.messages)) {
    return { thread: false, roster: false };
  }
  return snapshotRefreshAfterEvent({
    event: input.event,
    hasSnapshot: input.hadSnapshot,
    unknownRun,
    snapshotCursor: input.snapshotCursorBefore,
  });
}

function isKnownAdmission(event: StoredProductEvent, messages: readonly { id: string }[] | undefined): boolean {
  if (event.type !== "message.admitted" || !messages) return false;
  const messageId = event.payload.messageId;
  return typeof messageId === "string" && messages.some((message) => message.id === messageId);
}
