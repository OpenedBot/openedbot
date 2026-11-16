/**
 * Dev-only performance probe for the conversation thread.
 *
 * Framework-free measurement logic: no React, no DOM writes outside the
 * bookkeeping this file owns. `thread-perf-hud.tsx` is the only consumer
 * that renders anything. Everything here is driven by observers
 * (MutationObserver, PerformanceObserver, capture-phase event listeners)
 * so node counts are read only through `refreshContext()`. Reply-paint
 * samples check clipping after two animation frames, outside React commits.
 *
 * Chromium's Long Animation Frames API (`long-animation-frame`) is what
 * proved the send regression: a `forcedStyleAndLayoutDuration` of
 * 308 ms attributed to a specific script inside the Enter handler, which
 * a plain `longtask` entry cannot name. `PerformanceLongAnimationFrameTiming`
 * is not yet in TypeScript's `lib.dom.d.ts`, hence the local types in `thread-perf-helpers.ts`
 * instead of `any`. Browsers without the API (or without PerformanceObserver
 * long-animation-frame support at all) fall back to `longtask`, which only
 * gives `duration`.
 */

import { replyTextVisible, visibleReplyText, type ReplyText } from "./thread-reply-paint";
export { intersectPaintBounds } from "./thread-reply-paint";
import {
  applyRunEventReceipt,
  emptyRunLatency,
  framesOverlapping,
  linkAcceptedRun,
  percentile,
  recordPaintedRunText,
  rendersOverlapping,
  RUN_LINK_WINDOW_MS,
  toLongFrame,
  worstLongFrame,
} from "./thread-perf-helpers";
import {
  THREAD_PERF_BUDGETS,
  type LongFrame,
  type RenderSample,
  type RunEventReceipts,
  type SendSample,
  type StreamingWindow,
  type ThreadPerfBudgets,
  type ThreadPerfContext,
  type ThreadPerfGlobal,
  type ThreadPerfSnapshot,
  type TypingSample,
} from "./thread-perf-types";

export * from "./thread-perf-helpers";
export * from "./thread-perf-types";

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
const MAX_EARLY_RUNS = 50;

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

function frameKey(frame: Pick<LongFrame, "startTime" | "duration">): string {
  return `${frame.startTime.toFixed(3)}:${frame.duration.toFixed(3)}`;
}

type Listener = () => void;
type PendingReplyPaint = { runId: string; kind: "activity" | "answer"; text: ReplyText; frame: number };

/**
 * Owns the observers and the rolling history. One instance per app root
 * (`createThreadPerfProbe` in the HUD), started only when dev + opt-in.
 */
export class ThreadPerfProbe {
  private readonly budgets: ThreadPerfBudgets;
  private perfObserver: PerformanceObserver | null = null;
  private threadObserver: MutationObserver | null = null;
  private threadHostObserver: MutationObserver | null = null;
  private replyStyleObserver: MutationObserver | null = null;
  private replyResizeObserver: ResizeObserver | null = null;
  private threadTarget: Element | null = null;
  private replyPanelTarget: HTMLElement | null = null;
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
  private replyScanFrame: number | null = null;
  private pendingReplyPaints = new Map<HTMLElement, PendingReplyPaint>();
  private paintedRuns = new Map<string, { firstAt: number | null; answerAt: number | null }>();

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
    document.addEventListener("scroll", this.onReplyVisibilityChange, true);
    document.addEventListener("visibilitychange", this.onReplyVisibilityChange);
    document.addEventListener("load", this.onReplyVisibilityChange, true);
    document.addEventListener("transitionend", this.onReplyVisibilityChange, true);
    document.addEventListener("animationend", this.onReplyVisibilityChange, true);
    window.addEventListener("resize", this.onReplyVisibilityChange);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.perfObserver?.disconnect();
    this.threadObserver?.disconnect();
    this.threadHostObserver?.disconnect();
    this.replyStyleObserver?.disconnect();
    this.replyResizeObserver?.disconnect();
    this.threadTarget = null;
    this.replyPanelTarget = null;
    this.cancelReplyPaints();
    document.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("pointerdown", this.onSendPointerDown, true);
    document.removeEventListener("input", this.onComposerInput, true);
    document.removeEventListener("scroll", this.onReplyVisibilityChange, true);
    document.removeEventListener("visibilitychange", this.onReplyVisibilityChange);
    document.removeEventListener("load", this.onReplyVisibilityChange, true);
    document.removeEventListener("transitionend", this.onReplyVisibilityChange, true);
    document.removeEventListener("animationend", this.onReplyVisibilityChange, true);
    window.removeEventListener("resize", this.onReplyVisibilityChange);
    if (this.typingIdleTimer) clearTimeout(this.typingIdleTimer);
    if (this.streamingIdleTimer) clearTimeout(this.streamingIdleTimer);
  }

  reset(): void {
    this.cancelReplyPaints();
    this.paintedRuns.clear();
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
      if (!this.started || this.pendingSend !== pending || pending.resolved || pending.composerEmptiedAt !== null) return;
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

  recordSendSubmission(submissionId: string): void {
    // A retry keeps the logical request's original trigger. Exact keys can
    // link beyond the legacy 10 s window; the user waited through the retry.
    if (!this.started || !this.pendingSend || this.samples.some((sample) => sample.submissionId === submissionId)) return;
    const sample = this.findSample(this.pendingSend.id);
    if (sample && sample.run.runId === null && sample.submissionId === undefined) sample.submissionId = submissionId;
  }

  recordRunAccepted(runId: string, submissionId?: string): void {
    if (!this.started) return;
    const early = this.earlyRuns.get(runId);
    this.earlyRuns.delete(runId);
    if (linkAcceptedRun(this.samples, runId, performance.now(), early, submissionId)) this.notify();
    this.syncReplyPaints();
    this.observeReplyPaint();
  }

  /** Called for every organization event: only a first receipt notifies. */
  recordRunEvent(runId: string, type: string): void {
    if (!this.started) return;
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
      this.syncReplyPaints();
      this.observeReplyPaint();
      return;
    }
    // An event can beat its own 202 to the client; keep it only while a send
    // is waiting to be linked, so the rest of the organization's traffic
    // never accumulates here.
    const waiting = this.hasUnlinkedSend(at);
    if (!waiting) return;
    const early = this.earlyRuns.get(runId) ?? { firstEventAt: null, firstTextAt: null, completedAt: null };
    applyRunEventReceipt(early, type, at);
    this.earlyRuns.set(runId, early);
    if (this.earlyRuns.size > MAX_EARLY_RUNS) {
      const oldest = this.earlyRuns.keys().next().value;
      if (oldest !== undefined) this.earlyRuns.delete(oldest);
    }
    this.observeReplyPaint();
  }

  // -- Thread DOM observation (send bubble, typing mutations, streaming) ----

  private installThreadObserver(): void {
    if (typeof MutationObserver === "undefined") return;
    this.threadObserver = new MutationObserver((mutations) => this.onThreadMutations(mutations));
    // Rebind when navigation replaces the thread. The normal path is only a
    // connectivity check, including mutations made by the HUD itself.
    this.threadHostObserver = new MutationObserver((mutations) => {
      const panelChanged = this.replyPanelTarget ? !this.replyPanelTarget.isConnected : mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some((node) => node instanceof Element
          && (node.matches("[data-thoughts-panel]") || node.querySelector("[data-thoughts-panel]"))));
      if (!this.threadTarget?.isConnected || panelChanged) {
        this.attachThreadObserverTarget();
        this.observeReplyPaint();
      }
    });
    this.threadHostObserver.observe(document.body, { childList: true, subtree: true });
    this.replyStyleObserver = new MutationObserver(this.onReplyVisibilityChange);
    if (typeof ResizeObserver !== "undefined") this.replyResizeObserver = new ResizeObserver(this.onReplyVisibilityChange);
    this.attachThreadObserverTarget();
  }

  private attachThreadObserverTarget(): void {
    const thread = document.querySelector("[data-thread-messages]");
    const panel = document.querySelector<HTMLElement>("[data-thoughts-panel]");
    if (thread === this.threadTarget && panel === this.replyPanelTarget) return;
    this.threadObserver?.disconnect();
    this.replyStyleObserver?.disconnect();
    this.replyResizeObserver?.disconnect();
    this.threadTarget = thread;
    this.replyPanelTarget = panel;
    for (const surface of [thread, panel]) {
      if (!surface || !this.threadObserver) continue;
      this.threadObserver.observe(surface, { childList: true, characterData: true, attributes: true,
        attributeFilter: ["class", "style", "hidden", "open", "data-run-id"], subtree: true });
      this.replyResizeObserver?.observe(surface);
      for (let ancestor = surface.parentElement; ancestor; ancestor = ancestor.parentElement) {
        this.replyStyleObserver?.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
        this.replyResizeObserver?.observe(ancestor);
      }
    }
  }

  private onThreadMutations(records: MutationRecord[]): void {
    this.observeReplyPaint();
    // The portalled panel is a reply surface, not thread typing/streaming noise.
    const mutations = records.filter((record) => this.threadTarget?.contains(record.target));
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

  private onReplyVisibilityChange = (): void => { this.observeReplyPaint(); };

  private replyPaintRunIds(): Set<string> {
    const ids = new Set(this.samples.filter((sample) => sample.run.runId && sample.run.firstTextMs !== null
      && sample.run.answerPaintedMs === null).map((sample) => sample.run.runId!));
    if (this.hasUnlinkedSend(performance.now())) {
      for (const [runId, receipts] of this.earlyRuns) if (receipts.firstTextAt !== null && !this.paintedRuns.get(runId)?.answerAt) ids.add(runId);
    }
    return ids;
  }

  private hasUnlinkedSend(at: number): boolean {
    return this.samples.some((sample) => sample.run.runId === null
      && (sample.submissionId !== undefined || at - sample.triggeredAt <= RUN_LINK_WINDOW_MS));
  }

  private observeReplyPaint(): void {
    if (!this.started || this.replyScanFrame !== null || document.visibilityState === "hidden" || this.replyPaintRunIds().size === 0) return;
    // Layout reads are coalesced outside mutation/scroll handlers. Crucially,
    // the two-frame wait starts AFTER finding actual visible DOM text.
    this.replyScanFrame = requestAnimationFrame(() => {
      this.replyScanFrame = null;
      if (!this.started || document.visibilityState === "hidden") return;
      this.scanReplyText();
    });
  }

  private scanReplyText(): void {
    if (!this.threadTarget?.isConnected) this.attachThreadObserverTarget();
    const runIds = this.replyPaintRunIds();
    for (const [container, pending] of this.pendingReplyPaints) {
      if (!runIds.has(pending.runId) || !this.replyCandidateValid(container, pending)) {
        cancelAnimationFrame(pending.frame);
        this.pendingReplyPaints.delete(container);
      }
    }
    for (const runId of runIds) {
      const roots = [...this.threadTarget?.querySelectorAll<HTMLElement>(`[data-run-id="${CSS.escape(runId)}"]`) ?? []];
      if (this.replyPanelTarget?.dataset.runId === runId) roots.push(this.replyPanelTarget);
      for (const root of roots) {
        const kind = root.matches("[data-assistant-response]") ? "answer" : "activity";
        const marks = this.paintedRuns.get(runId);
        const recordedAt = kind === "answer" ? marks?.answerAt : marks?.firstAt;
        if (recordedAt !== null && recordedAt !== undefined) continue;
        // Both authored and authorless feed rows, and the expanded narration.
        for (const container of root.querySelectorAll<HTMLElement>("[data-assistant-text]")) {
          if (this.pendingReplyPaints.has(container)) continue;
          const text = visibleReplyText(container);
          if (!text) continue;
          const pending: PendingReplyPaint = { runId, kind, text, frame: 0 };
          this.pendingReplyPaints.set(container, pending);
          pending.frame = requestAnimationFrame(() => {
            if (this.pendingReplyPaints.get(container) !== pending) return;
            pending.frame = requestAnimationFrame(() => {
              if (this.pendingReplyPaints.get(container) !== pending) return;
              this.pendingReplyPaints.delete(container);
              if (!this.replyCandidateValid(container, pending)) {
                this.observeReplyPaint();
                return;
              }
              const at = performance.now();
              const receipts = this.paintedRuns.get(runId) ?? { firstAt: null, answerAt: null };
              receipts.firstAt ??= at;
              if (kind === "answer") receipts.answerAt ??= at;
              this.paintedRuns.set(runId, receipts);
              if (this.paintedRuns.size > MAX_EARLY_RUNS) this.paintedRuns.delete(this.paintedRuns.keys().next().value!);
              this.syncReplyPaints();
            });
          });
        }
      }
    }
  }

  private replyCandidateValid(container: HTMLElement, pending: PendingReplyPaint): boolean {
    return this.started && document.visibilityState !== "hidden" && container.contains(pending.text.node) && replyTextVisible(pending.text);
  }

  private syncReplyPaints(): void {
    let changed = false;
    for (const sample of this.samples) {
      const receipts = sample.run.runId ? this.paintedRuns.get(sample.run.runId) : undefined;
      if (receipts?.firstAt !== null && receipts?.firstAt !== undefined) changed = recordPaintedRunText(sample.run, "activity", receipts.firstAt - sample.triggeredAt) || changed;
      if (receipts?.answerAt !== null && receipts?.answerAt !== undefined) changed = recordPaintedRunText(sample.run, "answer", receipts.answerAt - sample.triggeredAt) || changed;
    }
    if (changed) this.notify();
  }

  private cancelReplyPaints(): void {
    if (this.replyScanFrame !== null) cancelAnimationFrame(this.replyScanFrame);
    this.replyScanFrame = null;
    for (const pending of this.pendingReplyPaints.values()) cancelAnimationFrame(pending.frame);
    this.pendingReplyPaints.clear();
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
      recordSendSubmission: (submissionId) => probe.recordSendSubmission(submissionId),
      recordRunAccepted: (runId, submissionId) => probe.recordRunAccepted(runId, submissionId),
      recordRunEvent: (runId, type) => probe.recordRunEvent(runId, type),
    };
  };
  probe.subscribe(publish);
  probe.start();
  publish();
  return probe;
}
