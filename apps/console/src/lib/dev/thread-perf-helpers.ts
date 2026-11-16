/**
 * Pure helpers of the dev-only thread performance probe: window filtering,
 * run-latency bookkeeping and long-animation-frame entry parsing. No DOM
 * access beyond reading `location` to shorten script URLs.
 */

import type {
  LongFrame,
  RenderSample,
  RunEventReceipts,
  ScriptAttribution,
  SendRunLatency,
  SendSample,
} from "./thread-perf-types";

const TOP_RENDERS_PER_WINDOW = 5;
/** Legacy (keyless) sends link a 202 only within this window. */
export const RUN_LINK_WINDOW_MS = 10_000;

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function worstLongFrame(frames: readonly LongFrame[]): number {
  return frames.reduce((worst, frame) => Math.max(worst, frame.duration), 0);
}

/**
 * Frames whose `[startTime, startTime + duration]` overlaps
 * `[windowStart, windowEnd]`, not frames that *started* inside it: the
 * frame containing the Enter keydown routinely starts a few ms before the
 * trigger timestamp and must not be dropped.
 */
export function framesOverlapping(
  frames: readonly LongFrame[],
  windowStart: number,
  windowEnd: number,
): LongFrame[] {
  return frames.filter((frame) => frame.startTime + frame.duration > windowStart && frame.startTime < windowEnd);
}

export function rendersOverlapping(
  renders: readonly RenderSample[],
  windowStart: number,
  windowEnd: number,
  limit = TOP_RENDERS_PER_WINDOW,
): RenderSample[] {
  return renders
    .filter((render) => render.commitTime >= windowStart && render.commitTime <= windowEnd)
    .sort((a, b) => b.actualMs - a.actualMs)
    .slice(0, limit);
}

export function emptyRunLatency(): SendRunLatency {
  return { runId: null, acceptedMs: null, firstEventMs: null, firstTextMs: null, firstPaintedTextMs: null, answerPaintedMs: null, completedMs: null };
}

/** A DOM paint is distinct from SSE receipt and terminal completion. */
export function recordPaintedRunText(run: SendRunLatency, kind: "activity" | "answer", elapsed: number): boolean {
  if (run.firstTextMs === null || !Number.isFinite(elapsed) || elapsed < run.firstTextMs) return false;
  let changed = false;
  if (run.firstPaintedTextMs === null) {
    run.firstPaintedTextMs = elapsed;
    changed = true;
  }
  if (kind === "answer" && run.answerPaintedMs === null) {
    run.answerPaintedMs = elapsed;
    changed = true;
  }
  return changed;
}

/**
 * Applies one SSE receipt to a run's marks, first occurrence wins. Returns
 * whether anything changed. `agent.message` is the first text the thread can
 * render; a terminal event is the full reply.
 */
export function applyRunEventReceipt(receipts: RunEventReceipts, type: string, at: number): boolean {
  let changed = false;
  if (receipts.firstEventAt === null) {
    receipts.firstEventAt = at;
    changed = true;
  }
  if (type === "agent.message" && receipts.firstTextAt === null) {
    receipts.firstTextAt = at;
    changed = true;
  }
  if ((type === "run.completed" || type === "run.error") && receipts.completedAt === null) {
    receipts.completedAt = at;
    changed = true;
  }
  return changed;
}

/**
 * Links a 202 to its exact submission, folding in receipts that raced ahead
 * of it. Legacy callers without a key link only one unambiguous recent send.
 */
export function linkAcceptedRun(
  samples: SendSample[],
  runId: string,
  at: number,
  early: RunEventReceipts | undefined,
  submissionId?: string,
): SendSample | null {
  if (samples.some((sample) => sample.run.runId === runId)) return null;
  const waiting = samples.filter((candidate) => candidate.run.runId === null && at >= candidate.triggeredAt
    && (submissionId === undefined ? at - candidate.triggeredAt <= RUN_LINK_WINDOW_MS : candidate.submissionId === submissionId));
  const sample = waiting.length === 1 ? waiting[0] : undefined;
  if (!sample) return null;
  const since = (value: number | null) => (value === null ? null : value - sample.triggeredAt);
  sample.run = {
    ...sample.run,
    runId,
    acceptedMs: at - sample.triggeredAt,
    firstEventMs: since(early?.firstEventAt ?? null),
    firstTextMs: since(early?.firstTextAt ?? null),
    completedMs: since(early?.completedAt ?? null),
  };
  return sample;
}

function fileNameOf(sourceUrl: string | undefined | null): string | null {
  if (!sourceUrl) return null;
  try {
    const url = new URL(sourceUrl, typeof location !== "undefined" ? location.href : undefined);
    const segments = url.pathname.split("/");
    return segments.at(-1) || sourceUrl;
  } catch {
    return sourceUrl;
  }
}

/** Minimal shape of a `long-animation-frame` script entry, not yet in lib.dom.d.ts. */
type RawScriptTiming = {
  invoker?: string;
  invokerType?: string;
  sourceFunctionName?: string;
  sourceURL?: string;
  duration?: number;
  forcedStyleAndLayoutDuration?: number;
};

type RawLongAnimationFrameEntry = PerformanceEntry & {
  blockingDuration?: number;
  scripts?: RawScriptTiming[];
  styleAndLayoutStart?: number;
};

function readScripts(entry: RawLongAnimationFrameEntry): ScriptAttribution[] {
  if (!Array.isArray(entry.scripts)) return [];
  return entry.scripts.map((script) => ({
    invoker: script.invoker ?? null,
    invokerType: script.invokerType ?? null,
    sourceFunctionName: script.sourceFunctionName ?? null,
    sourceFile: fileNameOf(script.sourceURL),
    duration: script.duration ?? 0,
    forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration ?? 0,
  }));
}

export function toLongFrame(entry: PerformanceEntry): LongFrame {
  const raw = entry as RawLongAnimationFrameEntry;
  const scripts = readScripts(raw);
  const styleAndLayoutMs =
    raw.styleAndLayoutStart && raw.styleAndLayoutStart > 0
      ? Math.max(0, entry.startTime + entry.duration - raw.styleAndLayoutStart)
      : 0;
  const scriptsDuration = scripts.reduce((sum, script) => sum + script.duration, 0);
  const paintMs = Math.max(0, entry.duration - scriptsDuration - styleAndLayoutMs);
  return {
    startTime: entry.startTime,
    duration: entry.duration,
    blockingDuration: raw.blockingDuration ?? entry.duration,
    scripts,
    styleAndLayoutMs,
    paintMs,
  };
}
