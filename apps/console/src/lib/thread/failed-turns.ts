import type { StoredProductEvent } from "@openedbot/contracts-events";
import { isServiceStepKind } from "@openedbot/execution/domain/run-step";
import type { TimelineUserInput } from "./thread-timeline-model";

type FailedRunLike = {
  id: string;
  status: string;
  stepKind?: string | null;
  errorCode?: string | null;
  error?: string | null;
  createdAt?: string;
  endedAt?: string | null;
};

/** The operator's message that started each run: a failed turn names it and replays it. */
export function questionsByRun(userInputs: readonly TimelineUserInput[]): Map<string, { id: string; text: string }> {
  const map = new Map<string, { id: string; text: string }>();
  for (const input of userInputs) {
    if (input.runId && !input.authorBot && !map.has(input.runId)) map.set(input.runId, input);
  }
  return map;
}

// One stand-in per run object: the same snapshot gives the same event, so the
// turn keeps its node from one render to the next.
const standIns = new WeakMap<object, StoredProductEvent>();

/**
 * A run the snapshot says failed, whose closing `run.error` never reached the
 * thread (stream cut before it, or a run failed by a sweep that writes no
 * event): the turn would stay silent, with no action and no reference. It gets
 * a `run.error` built from the run (its code, its text), appended after the
 * events. The real event, once read, replaces it: never both.
 *
 * Only runs inside the read window get one: a run the window already shows
 * (an event or the operator's message), any run when no older history is
 * left to load, or a run not older than the oldest event or message loaded
 * (a room turn started by another bot has no operator message and may fail
 * before any event). A run whose history is not loaded yet keeps its real
 * event for when it is. With nothing to add, `events` comes back unchanged.
 */
export function withFailedRunErrors(
  events: readonly StoredProductEvent[],
  runs: readonly FailedRunLike[],
  userInputs: readonly TimelineUserInput[],
  olderHistory: boolean,
): readonly StoredProductEvent[] {
  if (!runs.some((run) => run.status === "failed")) return events;
  const shown = new Set<string>();
  const closed = new Set<string>();
  let oldest = Number.POSITIVE_INFINITY;
  for (const event of events) {
    shown.add(event.runId);
    if (event.type === "run.error" || event.type === "run.completed") closed.add(event.runId);
    oldest = Math.min(oldest, new Date(event.occurredAt).getTime() || oldest);
  }
  for (const input of userInputs) {
    if (input.runId) shown.add(input.runId);
    if (input.createdAt) oldest = Math.min(oldest, Date.parse(input.createdAt) || oldest);
  }
  const inWindow = (run: FailedRunLike) => shown.has(run.id) || !olderHistory
    || (run.createdAt !== undefined && Date.parse(run.createdAt) >= oldest);
  let withStandIns: StoredProductEvent[] | null = null;
  for (const run of runs) {
    if (run.status !== "failed" || closed.has(run.id) || !inWindow(run)) continue;
    let event = standIns.get(run);
    if (!event) {
      event = {
        runId: run.id,
        cursor: 0,
        sequence: Number.MAX_SAFE_INTEGER,
        type: "run.error",
        payload: { errorCode: run.errorCode ?? null, message: run.error ?? "" },
        occurredAt: new Date(run.endedAt ?? run.createdAt ?? Date.now()),
      };
      standIns.set(run, event);
    }
    (withStandIns ??= [...events]).push(event);
  }
  return withStandIns ?? events;
}

/**
 * The events the thread draws. SERVICE runs (persona draft, compaction, the
 * old memory extraction) share the bot's thread but have no bubble: their
 * output is consumed by the worker, and their events and failures stay out.
 * A shown run that failed without its `run.error` gets one (`withFailedRunErrors`).
 */
export function shownThreadEvents(
  events: readonly StoredProductEvent[],
  runs: readonly FailedRunLike[],
  userInputs: readonly TimelineUserInput[],
  olderHistory: boolean,
): readonly StoredProductEvent[] {
  const serviceRunIds = new Set(runs.filter((run) => isServiceStepKind(run.stepKind)).map((run) => run.id));
  if (serviceRunIds.size === 0) return withFailedRunErrors(events, runs, userInputs, olderHistory);
  const shownRuns = runs.filter((run) => !serviceRunIds.has(run.id));
  return withFailedRunErrors(events.filter((event) => !serviceRunIds.has(event.runId)), shownRuns, userInputs, olderHistory);
}
