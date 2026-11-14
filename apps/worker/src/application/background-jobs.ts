import { logEvent } from "@openedbot/platform-observability";
export type BackgroundJob = {
  /** Stable name, logged as `job` when the pass throws. */
  name: string;
  /** Minimum gap between two pass starts; a pass longer than this delays the next one. */
  everyMs: number;
  /**
   * First pass no earlier than this long after the worker started. Passes
   * that call hosts wait for link liveness to be decidable: an API killed
   * without a clean stop still looks alive, and still owns its links, for
   * up to 60 s.
   */
  firstAfterMs?: number;
  /**
   * `track`: work the pass starts without awaiting it (an approval review);
   * the worker drains it on shutdown like the pass itself.
   */
  run(signal: AbortSignal, track?: (work: Promise<void>) => void): Promise<void>;
};

/** Passes of one job since the worker started (rework-flux-api, step 0). */
export type BackgroundJobStats = { job: string; runs: number; totalMs: number; maxMs: number };

export type BackgroundJobs = {
  /** Starts every due job that is not already running. Never awaits a pass. */
  tick(now?: number): void;
  inFlight(): number;
  stats(): BackgroundJobStats[];
};

/**
 * Single-flight scheduler: each job has at most one pass in flight, and a pass
 * is only ever tracked through `track`, which the worker drains on shutdown.
 * A slow job (SMTP, push provider, R2, Cloudflare) therefore delays its own next
 * pass and nothing else.
 */
export function createBackgroundJobs(
  jobs: readonly BackgroundJob[],
  signal: AbortSignal,
  track: (execution: Promise<void>) => void,
): BackgroundJobs {
  const lastStartedAt = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  const stats = new Map<string, BackgroundJobStats>();
  let startedAt: number | undefined;

  function tick(now = Date.now()): void {
    startedAt ??= now;
    if (signal.aborted) return;
    for (const job of jobs) {
      if (running.has(job.name)) continue;
      if (job.firstAfterMs !== undefined && now - startedAt < job.firstAfterMs) continue;
      const last = lastStartedAt.get(job.name);
      if (last !== undefined && now - last < job.everyMs) continue;
      lastStartedAt.set(job.name, now);
      const passStartedAt = performance.now();
      const execution = Promise.resolve()
        .then(() => job.run(signal, track))
        .catch((error) => {
          logEvent("worker.job_failed", { job: job.name, error: String(error) }, "error");
        })
        .finally(() => {
          running.delete(job.name);
          const durationMs = Math.round(performance.now() - passStartedAt);
          const entry = stats.get(job.name) ?? { job: job.name, runs: 0, totalMs: 0, maxMs: 0 };
          entry.runs += 1;
          entry.totalMs += durationMs;
          entry.maxMs = Math.max(entry.maxMs, durationMs);
          stats.set(job.name, entry);
        });
      running.set(job.name, execution);
      track(execution);
    }
  }

  return {
    tick,
    inFlight: () => running.size,
    stats: () => [...stats.values()].map((entry) => ({ ...entry })).sort((a, b) => b.runs - a.runs),
  };
}

/**
 * Runs one maintenance pass and turns a throw into a single error log
 * line named `event`, so the job's next tick still runs. The error text joins
 * the line only with `withError`: leave it off when the message could carry a
 * customer value.
 */
export async function guardedPass(
  event: string,
  pass: () => Promise<void>,
  options: { withError?: boolean } = {},
): Promise<void> {
  try {
    await pass();
  } catch (error) {
    logEvent(event, options.withError ? { error: String(error) } : {}, "error");
  }
}
