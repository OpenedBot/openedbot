export type LatencyMarks = {
  acceptedMs: number | null;
  firstEventMs: number | null;
  firstTextMs: number | null;
  completeMs: number | null;
  queuedMs: number | null;
};

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
