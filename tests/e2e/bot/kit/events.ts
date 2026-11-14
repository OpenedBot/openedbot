/**
 * One `/api/events` stream for the whole run, opened before the first write
 * (a run can end before a late subscriber connects). It keeps, per run, the
 * client-side marks a bench needs and the terminal event a feature check reads.
 */
import type { OrganizationEvent } from "@openedbot/contracts-events";
import { readRuntimeChangedFrame, RUNTIME_CHANGED_FRAME } from "@openedbot/contracts-events";

export type SseFrame = { comment: string | null; data: string | null; event?: string };

/** Splits a text buffer into complete SSE frames; the incomplete tail is returned as `rest`. */
export function splitSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const frames = parts.map((part) => {
    const lines = part.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    const comment = lines.find((line) => line.startsWith(":"))?.slice(1).trim() ?? null;
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    return { comment, data: data.length ? data.join("\n") : null, ...(event ? { event } : {}) };
  });
  return { frames, rest };
}

export type RunMarks = {
  firstEvent?: number;
  firstText?: number;
  firstTool?: number;
  /** Tool calls the run made before ending (`tool.call` events). */
  toolCalls?: number;
  terminal?: number;
  terminalType?: "run.completed" | "run.error";
  terminalPayload?: Record<string, unknown>;
  terminalEvents?: number;
};

export type ObservedEvent = Pick<OrganizationEvent, "type" | "runId"> & { payload?: unknown; cursor?: number; sequence?: number };

const TERMINAL = new Set(["run.completed", "run.error"]);

export class EventStream {
  private cursor = 0;
  private stopped = false;
  private abort = new AbortController();
  private readonly marks = new Map<string, RunMarks>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly connected = Promise.withResolvers<void>();
  private task: Promise<void> | null = null;
  private readonly observed = new Map<string, ObservedEvent[]>();
  private observedCount = 0;
  private readonly seenCursors = new Set<number>();
  errors = 0;
  duplicates = 0;
  gaps = 0;
  malformed = 0;
  connections = 0;
  fatalError: string | null = null;

  constructor(private readonly baseUrl: string, private readonly headers: () => Record<string, string>) {}

  async start(timeoutMs = 5_000): Promise<void> {
    this.task = this.pump();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.connected.promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("/api/events never sent its connected comment.")), timeoutMs);
      })]);
    } catch (error) {
      await this.stop();
      throw error;
    } finally { clearTimeout(timer); }
  }

  /** Records one event at its receipt time; exported for tests through `observe`. */
  observe(event: ObservedEvent, at: number): void {
    if (event.cursor !== undefined) {
      if (this.seenCursors.has(event.cursor)) { this.duplicates++; return; }
      this.seenCursors.add(event.cursor);
    }
    if (this.observedCount >= 50_000) {
      this.fatalError = "E2E event evidence exceeded 50,000 frames.";
      throw new Error(this.fatalError);
    }
    const history = this.observed.get(event.runId) ?? [];
    history.push(event);
    this.observed.set(event.runId, history);
    this.observedCount++;
    const entry = this.marks.get(event.runId) ?? {};
    entry.firstEvent ??= at;
    if (event.type === "agent.message") entry.firstText ??= at;
    if (event.type === "tool.call") {
      entry.firstTool ??= at;
      entry.toolCalls = (entry.toolCalls ?? 0) + 1;
    }
    if (TERMINAL.has(event.type)) entry.terminalEvents = (entry.terminalEvents ?? 0) + 1;
    if (TERMINAL.has(event.type) && entry.terminal === undefined) {
      entry.terminal = at;
      entry.terminalType = event.type as RunMarks["terminalType"];
      entry.terminalPayload = (event.payload ?? {}) as Record<string, unknown>;
    }
    this.marks.set(event.runId, entry);
    if (entry.terminal !== undefined) for (const wake of this.waiters.get(event.runId) ?? []) wake();
  }

  marksOf(runId: string): RunMarks {
    return this.marks.get(runId) ?? {};
  }

  eventsOf(runId: string): readonly ObservedEvent[] { return this.observed.get(runId) ?? []; }

  /** Drops only this runner's subscription; the next request resumes its cursor. */
  reconnect(): void { this.abort.abort("test reconnect"); }

  /** Resolves with the run's marks once it is terminal, or `null` at the deadline. */
  waitTerminal(runId: string, timeoutMs: number): Promise<RunMarks | null> {
    const current = this.marks.get(runId);
    if (current?.terminal !== undefined) return Promise.resolve(current);
    return new Promise((resolve) => {
      const set = this.waiters.get(runId) ?? new Set();
      this.waiters.set(runId, set);
      const wake = () => {
        clearTimeout(timer);
        set.delete(wake);
        resolve(this.marks.get(runId) ?? null);
      };
      const timer = setTimeout(() => { set.delete(wake); resolve(null); }, timeoutMs);
      set.add(wake);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort("done");
    await this.task?.catch(() => undefined);
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const response = await fetch(`${this.baseUrl}/api/events?cursor=${this.cursor}`, { headers: this.headers(), signal: this.abort.signal });
        if (!response.ok || !response.body) throw new Error(`/api/events HTTP ${response.status}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body as ReadableStream<Uint8Array>) {
          const at = Date.now();
          const received = buffer + decoder.decode(chunk, { stream: true });
          if (received.length > 4_000_000) {
            this.fatalError = "E2E SSE frame exceeded 4 MB.";
            throw new Error(this.fatalError);
          }
          const { frames, rest } = splitSseFrames(received);
          buffer = rest;
          for (const frame of frames) {
            if (frame.comment === "connected") { this.connections++; this.connected.resolve(); }
            if (!frame.data) continue;
            if (frame.event === "stream.gap") { this.gaps++; continue; }
            let event: Partial<OrganizationEvent>;
            try { event = JSON.parse(frame.data) as Partial<OrganizationEvent>; } catch { this.malformed++; continue; }
            if (frame.event === RUNTIME_CHANGED_FRAME) {
              if (!readRuntimeChangedFrame(event)) this.malformed++;
              continue;
            }
            if (frame.event === "stream.cursor") {
              if (event && Number.isSafeInteger(event.cursor) && event.cursor! >= 0) this.cursor = Math.max(this.cursor, event.cursor!);
              else this.malformed++;
              continue;
            }
            if (frame.event === "stream.revoked") {
              this.fatalError = "Workspace access was revoked during E2E observation.";
              this.abort.abort(this.fatalError);
              return;
            }
            if (!event || typeof event !== "object" || Array.isArray(event)
              || typeof event.type !== "string" || typeof event.runId !== "string"
              || (event.cursor !== undefined && (!Number.isSafeInteger(event.cursor) || event.cursor < 0))) {
              this.malformed++;
              continue;
            }
            if (typeof event.cursor === "number") this.cursor = Math.max(this.cursor, event.cursor);
            if (typeof event.type === "string" && typeof event.runId === "string") {
              this.observe({ type: event.type, runId: event.runId, payload: event.payload, cursor: event.cursor, sequence: event.sequence }, at);
            }
          }
        }
      } catch {
        if (this.stopped || this.fatalError) return;
        this.errors += 1;
      }
      if (!this.stopped) await Bun.sleep(300);
    }
  }
}
