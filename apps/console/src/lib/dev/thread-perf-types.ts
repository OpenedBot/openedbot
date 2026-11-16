/**
 * Budgets and data shapes of the dev-only thread performance probe
 * (`thread-perf-probe.ts`). Types only, plus the default budgets.
 */

export type ThreadPerfBudgets = {
  /** Enter/send -> composer emptied + user bubble painted. */
  sendLatencyMs: number;
  /** Any long animation frame (or long task) during send, typing or streaming. */
  longFrameMs: number;
  /** DOM mutations inside [data-thread-messages] while only typing. */
  typingMutations: number;
  /** Worst long-frame duration per 10 s streaming window. */
  streamingFrameMs: number;
  /** Send -> 202 (local admission, network included). */
  acceptedMs: number;
  /** Send -> first SSE event of the accepted run. */
  firstEventMs: number;
  /** Send -> first `agent.message` of the accepted run. */
  firstTextMs: number;
  /** Send -> first rendered assistant text, after two animation frames. */
  firstPaintedTextMs: number;
};

export const THREAD_PERF_BUDGETS: ThreadPerfBudgets = {
  sendLatencyMs: 100,
  longFrameMs: 50,
  typingMutations: 0,
  streamingFrameMs: 50,
  acceptedMs: 300,
  firstEventMs: 3_000,
  firstTextMs: 4_500,
  firstPaintedTextMs: 1_000,
};

export type ScriptAttribution = {
  invoker: string | null;
  invokerType: string | null;
  sourceFunctionName: string | null;
  /** File name only (`sourceURL` truncated), kept short for the HUD. */
  sourceFile: string | null;
  duration: number;
  forcedStyleAndLayoutDuration: number;
};

export type LongFrame = {
  startTime: number;
  duration: number;
  blockingDuration: number;
  scripts: ScriptAttribution[];
  /** `startTime + duration - styleAndLayoutStart`; 0 when the browser didn't report it. */
  styleAndLayoutMs: number;
  /** `duration` minus every script's own duration and `styleAndLayoutMs`, floored at 0.
   *  Attributes frames with no script entry (seen: ~140 ms paint-only frames while streaming). */
  paintMs: number;
};

/** One React `Profiler.onRender` commit, forwarded by `DevRenderProfiler`. */
export type RenderSample = {
  id: string;
  phase: string;
  actualMs: number;
  commitTime: number;
};

export type SendSample = {
  id: string;
  /** The request's idempotency key, captured synchronously by the send hook. */
  submissionId?: string;
  triggeredAt: number;
  /** ms from trigger to the composer textarea reading `""` (polled, since React's
   *  programmatic clear fires no `input` event). Null while unresolved. */
  composerEmptiedMs: number | null;
  /** ms from trigger to the sent bubble's insertion being painted (double rAF). */
  bubblePaintedMs: number | null;
  /** `max(composerEmptiedMs, bubblePaintedMs)`; null until both resolve. */
  latencyMs: number | null;
  pass: boolean | null;
  longFrames: LongFrame[];
  worstLongFrameMs: number;
  longFramesPass: boolean;
  /** Renders committed during the send's 2 s window, worst `actualMs` first. */
  renders: RenderSample[];
  /** Run latency marks, all ms from the same trigger. Null until observed. */
  run: SendRunLatency;
};

export type SendRunLatency = {
  /** Linked by the 202; null until the API accepts the send. */
  runId: string | null;
  acceptedMs: number | null;
  firstEventMs: number | null;
  firstTextMs: number | null;
  firstPaintedTextMs: number | null;
  answerPaintedMs: number | null;
  completedMs: number | null;
};

/** Absolute `performance.now()` receipts for a run whose 202 isn't processed yet. */
export type RunEventReceipts = {
  firstEventAt: number | null;
  firstTextAt: number | null;
  completedAt: number | null;
};

export type TypingSample = {
  windowStart: number;
  windowEnd: number;
  longFrames: LongFrame[];
  worstLongFrameMs: number;
  mutations: number;
  pass: boolean;
};

export type StreamingWindow = {
  windowStart: number;
  windowEnd: number;
  sampleCount: number;
  worstMs: number;
  p95Ms: number;
  pass: boolean;
  /** Renders committed during this window, worst `actualMs` first. */
  renders: RenderSample[];
};

export type ThreadPerfContext = {
  threadNodeCount: number | null;
  documentNodeCount: number | null;
  turnsMounted: number | null;
  measuredAt: number | null;
};

export type ThreadPerfSnapshot = {
  enabled: boolean;
  supportsLongAnimationFrame: boolean;
  budgets: ThreadPerfBudgets;
  samples: SendSample[];
  typing: TypingSample[];
  streaming: StreamingWindow[];
  context: ThreadPerfContext;
};

/**
 * Shape published on `window.__openedbotThreadPerf`: the snapshot, `reset()`, and
 * `recordRender` - the registry `DevRenderProfiler` writes to without ever
 * importing this module. `undefined` (optional chained away) whenever the
 * HUD isn't mounted, so wrapping a component in `DevRenderProfiler` costs
 * nothing unless `?perf=1` is on.
 */
export type ThreadPerfGlobal = ThreadPerfSnapshot & {
  reset: () => void;
  recordRender: (id: string, phase: string, actualDuration: number, commitTime: number) => void;
  /** Forwarded by the send hook, before persistence/network work. */
  recordSendSubmission: (submissionId: string) => void;
  recordRunAccepted: (runId: string, submissionId?: string) => void;
  /** Forwarded by the organization SSE stream on every received event. */
  recordRunEvent: (runId: string, type: string) => void;
};
