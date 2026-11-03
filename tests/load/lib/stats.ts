/** Percentiles over a sample, nearest-rank, on a sorted copy. */
export type Summary = { count: number; p50: number; p95: number; max: number };

export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!;
}

export function summarize(values: readonly number[]): Summary {
  return {
    count: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: values.length === 0 ? Number.NaN : round(Math.max(...values)),
  };
}

export function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
}

/**
 * CPU time of a process from /proc/<pid>/stat (Linux only; null elsewhere):
 * utime + stime in clock ticks, 100 a second on every Linux Bun runs on.
 */
export async function cpuSeconds(pid: number): Promise<number | null> {
  try {
    const stat = await Bun.file(`/proc/${pid}/stat`).text();
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    return null;
  }
}
