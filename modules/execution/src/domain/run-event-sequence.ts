/**
 * Rules of `run_events.sequence` (ADR 0001 S2c, inventory 0002 section 5),
 * applied by the allocation primitive (`sql/run-events.ts`) once it holds the
 * run's row lock and the organization's cursor lock.
 *
 * A sequence is unique per run (the table's unique key) and strictly
 * increasing in commit order. Allocated events are contiguous; the worker's
 * stream proposes its own numbers (already published before the commit) and
 * may leave holes (a quiet room turn skips its deltas), never go back.
 */

export const RUN_EVENT_SEQUENCE_CONFLICT_CODE = "RUN_EVENT_SEQUENCE_CONFLICT";

/**
 * A proposed sequence is already taken (or not after the previous one): the
 * proposer's numbering is stale. Raised instead of dropping the event, which
 * used to skip the run transition it carried (defect D3).
 */
export class RunEventSequenceConflictError extends Error {
  readonly code = RUN_EVENT_SEQUENCE_CONFLICT_CODE;

  constructor(readonly runId: string, readonly proposed: number, readonly next: number) {
    super(`Le journal du run a changé pendant l’écriture : séquence ${proposed} proposée, ${next} attendue au minimum.`);
    this.name = "RunEventSequenceConflictError";
  }
}

/** `max(sequence) + 1`, or 0 for a run without events. */
export function nextSequenceAfter(last: number | string | null | undefined): number {
  if (last === null || last === undefined) return 0;
  const value = Number(last);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid stored run event sequence: ${String(last)}`);
  return value + 1;
}

/**
 * The first proposed sequence that would collide, with the smallest one it
 * could take, or null when the whole batch fits after `next`.
 */
export function proposedSequenceConflict(
  next: number,
  proposed: readonly number[],
): { proposed: number; next: number } | null {
  let floor = next;
  for (const sequence of proposed) {
    if (!Number.isSafeInteger(sequence) || sequence < floor) return { proposed: sequence, next: floor };
    floor = sequence + 1;
  }
  return null;
}
