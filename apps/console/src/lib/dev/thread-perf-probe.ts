/**
 * Dev-only performance probe for the conversation thread.
 *
 * Framework-free measurement logic: no React, no DOM writes outside the
 * bookkeeping this file owns. `thread-perf-hud.tsx` is the only consumer
 * that renders anything. Everything here is driven by observers
 * (MutationObserver, PerformanceObserver, capture-phase event listeners)
 * so the probe never itself reads layout in a hot path: node counts are
 * computed only through `refreshContext()`, called lazily by the HUD.
 *
 * Chromium's Long Animation Frames API (`long-animation-frame`) is what
 * proved the send regression: a `forcedStyleAndLayoutDuration` of
 * 308 ms attributed to a specific script inside the Enter handler, which
 * a plain `longtask` entry cannot name. `PerformanceLongAnimationFrameTiming`
 * is not yet in TypeScript's `lib.dom.d.ts`, hence the local types below
 * instead of `any`. Browsers without the API (or without PerformanceObserver
 * long-animation-frame support at all) fall back to `longtask`, which only
 * gives `duration`.
 */

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

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
};

export const THREAD_PERF_BUDGETS: ThreadPerfBudgets = {
  sendLatencyMs: 100,
  longFrameMs: 50,
  typingMutations: 0,
  streamingFrameMs: 50,
  acceptedMs: 300,
  firstEventMs: 3_000,
  firstTextMs: 4_500,
};

const SEND_WINDOW_MS = 2_000;
const SEND_TIMEOUT_MS = 5_000;
const TYPING_IDLE_MS = 1_000;
const STREAMING_WINDOW_MS = 10_000;
const STREAMING_IDLE_MS = 2_000;
const MAX_SEND_SAMPLES = 10;
const MAX_TYPING_SAMPLES = 10;
const MAX_STREAMING_WINDOWS = 12;
const MAX_LONG_FRAMES = 200;
const MAX_RENDERS = 500;
const TOP_RENDERS_PER_WINDOW = 5;
const RUN_LINK_WINDOW_MS = 10_000;
const MAX_EARLY_RUNS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Forwarded by `applySendAcceptedToCaches`. */
  recordRunAccepted: (runId: string) => void;
  /** Forwarded by the organization SSE stream on every received event. */
  recordRunEvent: (runId: string, type: string) => void;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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
  return { runId: null, acceptedMs: null, firstEventMs: null, firstTextMs: null, completedMs: null };
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
 * Links a 202 to the newest send not linked yet (within 10 s of its
 * trigger), folding in receipts that raced ahead of it. Null when no send is
 * waiting: a 202 from another tab or a retry is not this probe's sample.
 */
export function linkAcceptedRun(
  samples: SendSample[],
  runId: string,
  at: number,
  early: RunEventReceipts | undefined,
): SendSample | null {
  if (samples.some((sample) => sample.run.runId === runId)) return null;
  const sample = [...samples]
    .reverse()
    .find((candidate) => candidate.run.runId === null && at - candidate.triggeredAt <= RUN_LINK_WINDOW_MS);
  if (!sample) return null;
  const since = (value: number | null) => (value === null ? null : value - sample.triggeredAt);
  sample.run = {
    runId,
    acceptedMs: at - sample.triggeredAt,
    firstEventMs: since(early?.firstEventAt ?? null),
    firstTextMs: since(early?.firstTextAt ?? null),
    completedMs: since(early?.completedAt ?? null),
  };
  return sample;
}

function frameKey(frame: Pick<LongFrame, "startTime" | "duration">): string {
  return `${frame.startTime.toFixed(3)}:${frame.duration.toFixed(3)}`;
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

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

type Listener = () => void;

/**
 * Owns the observers and the rolling history. One instance per app root
 * (`createThreadPerfProbe` in the HUD), started only when dev + opt-in.
 */
export class ThreadPerfProbe {
  private readonly budgets: ThreadPerfBudgets;
  private perfObserver: PerformanceObserver | null = null;
  private threadObserver: MutationObserver | null = null;
  private threadTarget: Element | null = null;
  private supportsLongAnimationFrame = false;
  private started = false;

  private recentLongFrames: LongFrame[] = [];
  private recentRenders: RenderSample[] = [];
  private samples: SendSample[] = [];
  private typing: TypingSample[] = [];
  private streaming: StreamingWindow[] = [];
  private context: ThreadPerfContext = {
    threadNodeCount: null,
    documentNodeCount: null,
    turnsMounted: null,
    measuredAt: null,
  };

  private pendingSend: {
    id: string;
    triggeredAt: number;
    /** Trimmed composer value at trigger time; matched against added bubble text. */
    sentText: string;
    composerEmptiedAt: number | null;
    bubbleInsertedAt: number | null;
    resolved: boolean;
  } | null = null;

  private typingWindow: { windowStart: number; mutations: number } | null = null;
  private typingIdleTimer: ReturnType<typeof setTimeout> | null = null;

  private streamingWindow: { windowStart: number } | null = null;
  private streamingIdleTimer: ReturnType<typeof setTimeout> | null = null;

  private earlyRuns = new Map<string, RunEventReceipts>();

  private listeners = new Set<Listener>();

  constructor(budgets: ThreadPerfBudgets = THREAD_PERF_BUDGETS) {
    this.budgets = budgets;
  }

  start(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.installPerformanceObserver();
    this.installThreadObserver();
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("pointerdown", this.onSendPointerDown, true);
    document.addEventListener("input", this.onComposerInput, true);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.perfObserver?.disconnect();
    this.threadObserver?.disconnect();
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("pointerdown", this.onSendPointerDown, true);
    document.removeEventListener("input", this.onComposerInput, true);
    if (this.typingIdleTimer) clearTimeout(this.typingIdleTimer);
    if (this.streamingIdleTimer) clearTimeout(this.streamingIdleTimer);
  }

  reset(): void {
    this.samples = [];
    this.typing = [];
    this.streaming = [];
    this.recentLongFrames = [];
    this.recentRenders = [];
    this.pendingSend = null;
    this.typingWindow = null;
    this.streamingWindow = null;
    this.earlyRuns.clear();
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Node counts are a layout/tree read: only ever called on demand or on a slow interval. */
  refreshContext(): void {
    const thread = document.querySelector("[data-thread-messages]");
    this.context = {
      threadNodeCount: thread ? thread.querySelectorAll("*").length : null,
      documentNodeCount: document.querySelectorAll("*").length,
      turnsMounted: thread ? thread.children.length : null,
      measuredAt: performance.now(),
    };
    this.notify();
  }

  getSnapshot(): ThreadPerfSnapshot {
    return {
      enabled: this.started,
      supportsLongAnimationFrame: this.supportsLongAnimationFrame,
      budgets: this.budgets,
      samples: this.samples,
      typing: this.typing,
      streaming: this.streaming,
      context: this.context,
    };
  }

  // -- Performance observer -------------------------------------------------

  private installPerformanceObserver(): void {
    if (typeof PerformanceObserver === "undefined") return;
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    this.supportsLongAnimationFrame = supported.includes("long-animation-frame");
    const entryType = this.supportsLongAnimationFrame ? "long-animation-frame" : "longtask";
    if (!supported.includes(entryType)) return;
    try {
      this.perfObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.onLongFrame(toLongFrame(entry));
      });
      this.perfObserver.observe({ type: entryType, buffered: false });
    } catch {
      this.perfObserver = null;
    }
  }

  private onLongFrame(frame: LongFrame): void {
    // The browser can redeliver the same entry (buffered replay, a second
    // observer callback): drop it rather than double-count it in every
    // window that later filters `recentLongFrames`.
    const key = frameKey(frame);
    if (this.recentLongFrames.some((existing) => frameKey(existing) === key)) return;
    this.recentLongFrames.push(frame);
    if (this.recentLongFrames.length > MAX_LONG_FRAMES) this.recentLongFrames.shift();
    this.notify();
  }

  /** Forwarded by `DevRenderProfiler` through `window.__openedbotThreadPerf.recordRender`. */
  recordRender(id: string, phase: string, actualDuration: number, commitTime: number): void {
    this.recentRenders.push({ id, phase, actualMs: actualDuration, commitTime });
    if (this.recentRenders.length > MAX_RENDERS) this.recentRenders.shift();
  }

  // -- Send tracking ---------------------------------------------------------

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest?.("[data-composer]")) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      this.beginSend();
    }
  };

  private onSendPointerDown = (event: PointerEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest?.("[data-composer-send-action]")) return;
    this.beginSend();
  };

  private beginSend(): void {
    const textarea = document.querySelector<HTMLTextAreaElement>("[data-composer]");
    // The thread column remounts (skeleton, thread switch): an observer left
    // on a detached node never sees the bubble and the sample never resolves.
    if (this.threadTarget === null || !this.threadTarget.isConnected) this.attachThreadObserverTarget();
    const sentText = textarea?.value.trim() ?? "";
    if (!sentText) return; // Enter/send on an empty composer is not a real send.

    const triggeredAt = performance.now();
    const id = `send-${Math.round(triggeredAt)}-${Math.random().toString(36).slice(2, 7)}`;
    const pending = { id, triggeredAt, sentText, composerEmptiedAt: null, bubbleInsertedAt: null, resolved: false };
    this.pendingSend = pending;
    const sample: SendSample = {
      id,
      triggeredAt,
      composerEmptiedMs: null,
      bubblePaintedMs: null,
      latencyMs: null,
      pass: null,
      longFrames: [],
      worstLongFrameMs: 0,
      longFramesPass: true,
      renders: [],
      run: emptyRunLatency(),
    };
    this.samples.push(sample);
    if (this.samples.length > MAX_SEND_SAMPLES) this.samples.shift();
    this.pollComposerEmptied(pending);
    setTimeout(() => this.finalizeSend(id), SEND_WINDOW_MS);
    this.notify();
  }

  /**
   * React clears the composer with `setDraft("")`, a state update: no
   * `input` event fires. Polling `.value` on every rAF is a cheap property
   * read (not layout), and is the only reliable way to time the clear.
   */
  private pollComposerEmptied(pending: NonNullable<ThreadPerfProbe["pendingSend"]>): void {
    const step = () => {
      if (pending.resolved || pending.composerEmptiedAt !== null) return;
      const textarea = document.querySelector<HTMLTextAreaElement>("[data-composer]");
      if (textarea && textarea.value === "") {
        pending.composerEmptiedAt = performance.now();
        this.tryCompleteSend(pending);
        return;
      }
      if (performance.now() - pending.triggeredAt >= SEND_TIMEOUT_MS) return;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private onComposerInput = (event: Event): void => {
    const target = event.target as HTMLTextAreaElement | null;
    if (!target?.matches?.("[data-composer]")) return;
    if (target.value !== "") this.trackTyping();
  };

  private findSample(id: string): SendSample | undefined {
    return this.samples.find((sample) => sample.id === id);
  }

  private tryCompleteSend(pending: NonNullable<ThreadPerfProbe["pendingSend"]>): void {
    if (pending.resolved || pending.composerEmptiedAt === null || pending.bubbleInsertedAt === null) return;
    pending.resolved = true;
    // Double rAF after the bubble insertion, per the send budget definition
    // (insertion + two frames = "painted").
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const paintedAt = performance.now();
        const sample = this.findSample(pending.id);
        if (sample) {
          sample.composerEmptiedMs = pending.composerEmptiedAt! - pending.triggeredAt;
          sample.bubblePaintedMs = paintedAt - pending.triggeredAt;
          sample.latencyMs = Math.max(sample.composerEmptiedMs, sample.bubblePaintedMs);
          sample.pass = sample.latencyMs <= this.budgets.sendLatencyMs;
          this.notify();
        }
        if (this.pendingSend === pending) this.pendingSend = null;
      });
    });
  }

  private finalizeSend(id: string): void {
    const sample = this.findSample(id);
    if (sample) {
      const windowEnd = sample.triggeredAt + SEND_WINDOW_MS;
      sample.longFrames = framesOverlapping(this.recentLongFrames, sample.triggeredAt, windowEnd);
      sample.worstLongFrameMs = worstLongFrame(sample.longFrames);
      sample.longFramesPass = sample.longFrames.every((frame) => frame.duration <= this.budgets.longFrameMs);
      sample.renders = rendersOverlapping(this.recentRenders, sample.triggeredAt, windowEnd);
      this.notify();
    }
    if (this.pendingSend?.id === id) this.pendingSend = null;
  }

  // -- Run latency -------------------------------------------------

  recordRunAccepted(runId: string): void {
    const early = this.earlyRuns.get(runId);
    this.earlyRuns.delete(runId);
    if (linkAcceptedRun(this.samples, runId, performance.now(), early)) this.notify();
  }

  /** Called for every organization event: only a first receipt notifies. */
  recordRunEvent(runId: string, type: string): void {
    const at = performance.now();
    const sample = this.samples.find((candidate) => candidate.run.runId === runId);
    if (sample) {
      const receipts: RunEventReceipts = {
        firstEventAt: sample.run.firstEventMs,
        firstTextAt: sample.run.firstTextMs,
        completedAt: sample.run.completedMs,
      };
      if (!applyRunEventReceipt(receipts, type, at - sample.triggeredAt)) return;
      sample.run = {
        ...sample.run,
        firstEventMs: receipts.firstEventAt,
        firstTextMs: receipts.firstTextAt,
        completedMs: receipts.completedAt,
      };
      this.notify();
      return;
    }
    // An event can beat its own 202 to the client; keep it only while a send
    // is waiting to be linked, so the rest of the organization's traffic
    // never accumulates here.
    const waiting = this.samples.some(
      (candidate) => candidate.run.runId === null && at - candidate.triggeredAt <= RUN_LINK_WINDOW_MS,
    );
    if (!waiting) return;
    const early = this.earlyRuns.get(runId) ?? { firstEventAt: null, firstTextAt: null, completedAt: null };
    applyRunEventReceipt(early, type, at);
    this.earlyRuns.set(runId, early);
    if (this.earlyRuns.size > MAX_EARLY_RUNS) {
      const oldest = this.earlyRuns.keys().next().value;
      if (oldest !== undefined) this.earlyRuns.delete(oldest);
    }
  }

  // -- Thread DOM observation (send bubble, typing mutations, streaming) ----

  private installThreadObserver(): void {
    if (typeof MutationObserver === "undefined") return;
    this.threadObserver = new MutationObserver((mutations) => this.onThreadMutations(mutations));
    this.attachThreadObserverTarget();
  }

  private attachThreadObserverTarget(): void {
    const thread = document.querySelector("[data-thread-messages]");
    if (thread && this.threadObserver) {
      this.threadObserver.disconnect();
      this.threadObserver.observe(thread, { childList: true, subtree: true });
      this.threadTarget = thread;
      return;
    }
    // The thread screen mounts after navigation: retry until it exists.
    if (this.started) setTimeout(() => this.attachThreadObserverTarget(), 500);
  }

  private onThreadMutations(mutations: MutationRecord[]): void {
    const now = performance.now();
    const addedNodes = mutations.reduce((count, mutation) => count + mutation.addedNodes.length, 0);
    if (addedNodes === 0) return;

    const pending = this.pendingSend;
    if (pending && pending.bubbleInsertedAt === null) {
      // Match the added nodes' own text, not the whole thread (cheap: only
      // the nodes this batch just inserted), and against the composer's
      // value at trigger time so an unrelated mutation (streaming, another
      // tab) can't falsely resolve this send.
      const matchesSend = mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some((node) => (node.textContent ?? "").trim().includes(pending.sentText)),
      );
      if (matchesSend) {
        pending.bubbleInsertedAt = now;
        this.tryCompleteSend(pending);
        return; // The send's own bubble insertion is not "streaming" or "typing" noise.
      }
    }

    if (this.typingWindow) {
      this.typingWindow.mutations += addedNodes;
      this.notify();
      return;
    }

    this.trackStreaming(now);
  }

  // -- Typing tracking ---------------------------------------------------

  private trackTyping(): void {
    const now = performance.now();
    if (!this.typingWindow) {
      this.typingWindow = { windowStart: now, mutations: 0 };
    }
    if (this.typingIdleTimer) clearTimeout(this.typingIdleTimer);
    this.typingIdleTimer = setTimeout(() => this.closeTypingWindow(), TYPING_IDLE_MS);
  }

  private closeTypingWindow(): void {
    const window_ = this.typingWindow;
    if (!window_) return;
    this.typingWindow = null;
    const windowEnd = performance.now();
    const longFrames = framesOverlapping(this.recentLongFrames, window_.windowStart, windowEnd);
    const worst = worstLongFrame(longFrames);
    const sample: TypingSample = {
      windowStart: window_.windowStart,
      windowEnd,
      longFrames,
      worstLongFrameMs: worst,
      mutations: window_.mutations,
      pass: worst <= this.budgets.longFrameMs && window_.mutations <= this.budgets.typingMutations,
    };
    this.typing.push(sample);
    if (this.typing.length > MAX_TYPING_SAMPLES) this.typing.shift();
    this.notify();
  }

  // -- Streaming tracking --------------------------------------------------

  private trackStreaming(now: number): void {
    if (!this.streamingWindow) {
      this.streamingWindow = { windowStart: now };
    }
    if (this.streamingIdleTimer) clearTimeout(this.streamingIdleTimer);
    this.streamingIdleTimer = setTimeout(() => this.closeStreamingWindow(), STREAMING_IDLE_MS);
    if (now - this.streamingWindow.windowStart >= STREAMING_WINDOW_MS) {
      this.closeStreamingWindow();
    }
  }

  private closeStreamingWindow(): void {
    const window_ = this.streamingWindow;
    if (!window_) return;
    this.streamingWindow = null;
    const windowEnd = performance.now();
    const durations = framesOverlapping(this.recentLongFrames, window_.windowStart, windowEnd).map(
      (frame) => frame.duration,
    );
    const worst = durations.reduce((max, d) => Math.max(max, d), 0);
    const p95 = percentile(durations, 95);
    const sample: StreamingWindow = {
      windowStart: window_.windowStart,
      windowEnd,
      sampleCount: durations.length,
      worstMs: worst,
      p95Ms: p95,
      pass: worst <= this.budgets.streamingFrameMs,
      renders: rendersOverlapping(this.recentRenders, window_.windowStart, windowEnd),
    };
    this.streaming.push(sample);
    if (this.streaming.length > MAX_STREAMING_WINDOWS) this.streaming.shift();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// window.__openedbotThreadPerf wiring
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __openedbotThreadPerf?: ThreadPerfGlobal;
  }
}

/**
 * Creates the probe, starts it, and publishes a plain JSON-serializable
 * snapshot on `window.__openedbotThreadPerf` (kept fresh on every observer
 * notification) so browser automation can read it with one eval.
 */
export function installThreadPerfProbe(win: Window = window): ThreadPerfProbe {
  const probe = new ThreadPerfProbe();
  const publish = () => {
    win.__openedbotThreadPerf = {
      ...probe.getSnapshot(),
      reset: () => probe.reset(),
      recordRender: (id, phase, actualDuration, commitTime) => probe.recordRender(id, phase, actualDuration, commitTime),
      recordRunAccepted: (runId) => probe.recordRunAccepted(runId),
      recordRunEvent: (runId, type) => probe.recordRunEvent(runId, type),
    };
  };
  probe.subscribe(publish);
  probe.start();
  publish();
  return probe;
}
