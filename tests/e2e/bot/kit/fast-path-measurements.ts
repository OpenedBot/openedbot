export type LatencyMarks = {
  acceptedMs: number | null;
  firstEventMs: number | null;
  firstTextMs: number | null;
  completeMs: number | null;
  queuedMs: number | null;
};

type WorkerTimings = { queuedMs: number | null; marks: Record<string, number> };

export function hasCurrentWorkerTimings(run: { leaseGeneration?: number | string; timings?: (WorkerTimings & { attributes?: Record<string, unknown> }) | null } | null): boolean {
  // PostgreSQL bigint values read as strings with Bun's default SQL options.
  const generation = Number(run?.leaseGeneration);
  return Number.isSafeInteger(generation) && generation > 0 && run?.timings?.attributes?.lease_generation === generation
    && Object.values(workerLatencyBreakdown(run.timings)).every((value) => value !== null);
}

/**
 * Queue age ends inside the claim query; preparation starts after that claim
 * returns. The trace origin precedes the query, so its absolute POST offset
 * would overlap the queue. The remaining claim transaction is not attributed.
 */
export function workerLatencyBreakdown(timings: WorkerTimings | null | undefined): {
  queuedMs: number | null; beforeRuntimeMs: number | null; runtimeFirstTextMs: number | null; publishTextMs: number | null;
} {
  const valid = (value: number | null | undefined): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const marks = timings?.marks ?? {};
  const delta = (end: string, start: string): number | null => {
    const last = valid(marks[end]), first = valid(marks[start]);
    return last !== null && first !== null ? valid(last - first) : null;
  };
  return {
    queuedMs: valid(timings?.queuedMs),
    beforeRuntimeMs: delta("hermes.post_sent", "worker.claimed"),
    runtimeFirstTextMs: delta("hermes.first_text_delta", "hermes.post_sent"),
    publishTextMs: delta("openedbot.first_text_published", "hermes.first_text_delta"),
  };
}

const MARKS = ["acceptedMs", "firstEventMs", "firstTextMs", "completeMs", "queuedMs"] as const;
const validMark = (value: number | null): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function missingLatencyMarks(sample: LatencyMarks): Array<keyof LatencyMarks> {
  return MARKS.filter((mark) => !validMark(sample[mark]));
}

export function hasNonEmptyAssistantText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.some((part: unknown) =>
    !!part && typeof part === "object" && "type" in part && part.type === "text"
    && "text" in part && typeof part.text === "string" && part.text.trim().length > 0);
}

export function latencyStats(values: Array<number | null>) {
  const kept = values.filter(validMark).sort((a, b) => a - b);
  const percentile = (p: number) => kept.length
    ? Math.round(kept[Math.ceil((p / 100) * kept.length) - 1]!)
    : null;
  return {
    n: kept.length,
    expected: values.length,
    missing: values.length - kept.length,
    p50: percentile(50),
    p95: percentile(95),
    max: kept.length ? Math.round(kept[kept.length - 1]!) : null,
  };
}

/** Only the API's complete connection comment proves that the SSE body opened. */
export function createSseReadiness() {
  let connected = false;
  const waiters = new Set<() => void>();
  return {
    observeFrame(frame: string): void {
      if (!frame.split(/\r?\n/).some((line) => line === ": connected")) return;
      connected = true;
      for (const ready of [...waiters]) ready();
    },
    wait(timeoutMs: number): Promise<boolean> {
      if (connected) return Promise.resolve(true);
      return new Promise((resolve) => {
        const ready = () => {
          clearTimeout(timer);
          waiters.delete(ready);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(ready);
          resolve(false);
        }, timeoutMs);
        waiters.add(ready);
      });
    },
  };
}
