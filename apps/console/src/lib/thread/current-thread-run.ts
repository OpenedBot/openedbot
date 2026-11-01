import type { ProductRunStatus, RunDto } from "@openedbot/contracts-api";

const EXECUTING_STATUSES: ReadonlySet<ProductRunStatus> = new Set([
  "starting",
  "running",
  "awaiting_approval",
]);

const WAITING_STATUSES: ReadonlySet<ProductRunStatus> = new Set(["queued", "pending"]);

/** Les statuts qui occupent effectivement le moteur Hermes. */
export function isExecutingThreadRun(run: Pick<RunDto, "status">): boolean {
  return EXECUTING_STATUSES.has(run.status);
}

/** Les statuts qui attendent leur tour derrière un run exécutable. */
export function isWaitingThreadRun(run: Pick<RunDto, "status">): boolean {
  return WAITING_STATUSES.has(run.status);
}

/**
 * Resolves the run that owns the thread controls.
 *
 * Runs are chronological in the thread snapshot. A follow-up may already be
 * queued while an older run is still executing, so the last row is not
 * necessarily the run whose status and stop control belong in the composer.
 */
export function currentThreadRun(runs: readonly RunDto[]): RunDto | undefined {
  return (
    runs.find(isExecutingThreadRun) ??
    runs.find(isWaitingThreadRun) ??
    runs.at(-1)
  );
}
