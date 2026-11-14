/**
 * The real time of an answer, as the thread already knows it: the run carries
 * its creation, its end and its tokens, its `agent.message` events their time.
 *
 * Origin: the creation of the run, that is the instant the API accepted the
 * message (a few milliseconds after the click). « Premier jeton » is the
 * first chunk of text produced by the model, « Total » the end of the run.
 */
export type RunTiming = {
  firstTokenMs: number | null;
  totalMs: number;
  /** Output tokens (reasoning included) per second of the whole run, `null` without usage. */
  tokensPerSecond: number | null;
  /** Number of text chunks received from the model. */
  chunks: number;
};

type TimedRun = ClockedRun & {
  endedAt?: string | null;
  usage?: { outputTokens?: number } | null;
};

type TimedEvent = {
  runId: string;
  type: string;
  occurredAt: Date | string;
};

const at = (value: Date | string): number => new Date(value).getTime();

type ClockedRun = {
  id: string;
  status?: string;
  origin?: string | null;
  createdAt?: string;
  startedAt?: string | null;
};

const greetingSeenAt = new Map<string, number>();

/**
 * The origin of a turn's timers (« Réfléchit… 3 s », duration under the bubble):
 * the creation of the run, the instant the API accepted the message. Except for
 * a new bot's greeting: nobody sent it, and it waits in the queue for the
 * end of profile preparation, which the hub screen has already shown;
 * counted from its creation, it reached « Réfléchit… 11 s ». It starts from the
 * first time this client sees it in progress (the thread arrives at that moment),
 * or, reloaded once finished, from its real start. Not from the live cache's
 * `startedAt`: it is set on RECEIPT of the first event and
 * would restart the timer at zero when the text arrives.
 */
export function runClockStart(run: ClockedRun): number {
  const created = run.createdAt ? at(run.createdAt) : Number.NaN;
  if (run.origin !== "bot_greeting") return created;
  const seen = greetingSeenAt.get(run.id);
  if (seen !== undefined) return Math.max(created, seen);
  const settled = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  if (settled) return run.startedAt ? Math.max(created, at(run.startedAt)) : created;
  const now = Date.now();
  greetingSeenAt.set(run.id, now);
  return Math.max(created, now);
}

/** Finished runs only: a run in progress does not have a duration yet. */
export function runTimings(
  runs: readonly TimedRun[],
  events: readonly TimedEvent[],
  runIds?: ReadonlySet<string>,
  eventsByRun?: ReadonlyMap<string, readonly TimedEvent[]>,
  runsById?: ReadonlyMap<string, TimedRun>,
): Map<string, RunTiming> {
  const firstText = new Map<string, number>();
  const chunks = new Map<string, number>();
  const addTextEvent = (event: TimedEvent) => {
    if (event.type !== "agent.message") return;
    const time = at(event.occurredAt);
    const known = firstText.get(event.runId);
    if (known === undefined || time < known) firstText.set(event.runId, time);
    chunks.set(event.runId, (chunks.get(event.runId) ?? 0) + 1);
  };
  if (runIds && eventsByRun) {
    for (const runId of runIds) {
      for (const event of eventsByRun.get(runId) ?? []) addTextEvent(event);
    }
  } else {
    for (const event of events) {
      if (runIds && !runIds.has(event.runId)) continue;
      addTextEvent(event);
    }
  }
  const timings = new Map<string, RunTiming>();
  const addRunTiming = (run: TimedRun) => {
    if (!run.createdAt || !run.endedAt) return;
    const start = runClockStart(run);
    const end = at(run.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
    const first = firstText.get(run.id);
    // Over the total duration, like assistant-ui: output tokens also count
    // reasoning, produced BEFORE the first visible text. Dividing them
    // by the writing phase alone inflated the speed.
    const totalMs = end - start;
    const output = run.usage?.outputTokens ?? 0;
    timings.set(run.id, {
      firstTokenMs: first !== undefined ? Math.max(0, first - start) : null,
      totalMs,
      tokensPerSecond: output > 0 && totalMs > 0 ? output / (totalMs / 1000) : null,
      chunks: chunks.get(run.id) ?? 0,
    });
  };
  if (runIds && runsById) {
    for (const runId of runIds) {
      const run = runsById.get(runId);
      if (run) addRunTiming(run);
    }
  } else {
    for (const run of runs) {
      if (runIds && !runIds.has(run.id)) continue;
      addRunTiming(run);
    }
  }
  return timings;
}

/** « 4.03s »: the short form, under the bubble and in the detail. */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}
