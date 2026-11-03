/**
 * One `/api/events` stream for the whole run, opened before the first write
 * (a run can end before a late subscriber connects). It keeps, per run, the
 * client-side marks a bench needs and the terminal event a feature check reads.
 */
import type { OrganizationEvent } from "@openedbot/contracts-events";

export type SseFrame = { comment: string | null; data: string | null };

/** Splits a text buffer into complete SSE frames; the incomplete tail is returned as `rest`. */
export function splitSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const frames = parts.map((part) => {
    const lines = part.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    const comment = lines.find((line) => line.startsWith(":"))?.slice(1).trim() ?? null;
    return { comment, data: data.length ? data.join("\n") : null };
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
};

const TERMINAL = new Set(["run.completed", "run.error"]);

export class EventStream {
  private cursor = 0;
  private stopped = false;
  private abort = new AbortController();
  private readonly marks = new Map<string, RunMarks>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly connected = Promise.withResolvers<void>();
  private task: Promise<void> | null = null;
  errors = 0;

  constructor(private readonly baseUrl: string, private readonly headers: () => Record<string, string>) {}

  async start(timeoutMs = 5_000): Promise<void> {
    this.task = this.pump();
    const timer = Bun.sleep(timeoutMs).then(() => { throw new Error("/api/events never sent its connected comment."); });
    await Promise.race([this.connected.promise, timer]);
  }

  /** Records one event at its receipt time; exported for tests through `observe`. */
  observe(event: Pick<OrganizationEvent, "type" | "runId"> & { payload?: unknown }, at: number): void {
    const entry = this.marks.get(event.runId) ?? {};
    entry.firstEvent ??= at;
    if (event.type === "agent.message") entry.firstText ??= at;
    if (event.type === "tool.call") {
      entry.firstTool ??= at;
      entry.toolCalls = (entry.toolCalls ?? 0) + 1;
    }
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
          const { frames, rest } = splitSseFrames(buffer + decoder.decode(chunk, { stream: true }));
          buffer = rest;
          for (const frame of frames) {
            if (frame.comment === "connected") this.connected.resolve();
            if (!frame.data) continue;
            let event: Partial<OrganizationEvent>;
            try { event = JSON.parse(frame.data) as Partial<OrganizationEvent>; } catch { continue; }
            if (typeof event.cursor === "number") this.cursor = Math.max(this.cursor, event.cursor);
            if (typeof event.type === "string" && typeof event.runId === "string") {
              this.observe({ type: event.type, runId: event.runId, payload: event.payload }, at);
            }
          }
        }
      } catch {
        if (this.stopped) return;
        this.errors += 1;
      }
      if (!this.stopped) await Bun.sleep(300);
    }
  }
}
