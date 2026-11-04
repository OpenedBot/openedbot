export type BackgroundJob = {
  /** Stable name, logged as `job` when the pass throws. */
  name: string;
  /** Minimum gap between two pass starts; a pass longer than this delays the next one. */
  everyMs: number;
  /**
   * `track`: work the pass starts without awaiting it (an approval review);
   * the worker drains it on shutdown like the pass itself.
   */
  run(signal: AbortSignal, track?: (work: Promise<void>) => void): Promise<void>;
};

export type BackgroundJobs = {
  /** Starts every due job that is not already running. Never awaits a pass. */
  tick(now?: number): void;
  inFlight(): number;
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

  function tick(now = Date.now()): void {
    if (signal.aborted) return;
    for (const job of jobs) {
      if (running.has(job.name)) continue;
      const last = lastStartedAt.get(job.name);
      if (last !== undefined && now - last < job.everyMs) continue;
      lastStartedAt.set(job.name, now);
      const execution = Promise.resolve()
        .then(() => job.run(signal, track))
        .catch((error) => {
          console.error(JSON.stringify({ event: "worker.job_failed", job: job.name, error: String(error) }));
        })
        .finally(() => {
          running.delete(job.name);
        });
      running.set(job.name, execution);
      track(execution);
    }
  }

  return { tick, inFlight: () => running.size };
}

/**
 * Runs one maintenance pass and turns a throw into a single `console.error`
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
    console.error(JSON.stringify(options.withError ? { event, error: String(error) } : { event }));
  }
}
