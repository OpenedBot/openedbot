import { notifyManager } from "@tanstack/react-query";

/**
 * One flush per frame for every consumer of the organization stream.
 *
 * A running run emits dozens of events per second. The shell projection
 * patches the roster and the open thread patches its snapshot: flushed in
 * two frames callbacks, the conversation screen, which observes both keys,
 * rendered twice per frame. Here every pending flush runs in the same
 * callback, under one notification batch.
 *
 * A background tab no longer receives (or almost no longer receives)
 * `requestAnimationFrame`: a 200 ms timer keeps it up to date instead of
 * accumulating everything until the return to the foreground.
 */
const HIDDEN_FLUSH_MS = 200;

const pending = new Map<object, () => void>();
let frame: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function run(): void {
  frame = null;
  timer = null;
  const flushes = [...pending.values()];
  pending.clear();
  notifyManager.batch(() => {
    for (const flush of flushes) flush();
  });
}

/** Runs `flush` on the next frame; the owner's previous pending flush is replaced. */
export function scheduleStreamFlush(owner: object, flush: () => void): void {
  pending.set(owner, flush);
  if (frame !== null || timer !== null) return;
  const hidden = typeof document !== "undefined" && document.hidden;
  if (!hidden && typeof requestAnimationFrame === "function") {
    frame = requestAnimationFrame(run);
  } else {
    timer = setTimeout(run, HIDDEN_FLUSH_MS);
  }
}

/** The owner flushes by itself (cleanup, a timer of its own): drop its pending flush. */
export function cancelStreamFlush(owner: object): void {
  pending.delete(owner);
  if (pending.size > 0) return;
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
