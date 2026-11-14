import type { RuntimeChangedFrame, StreamCursor, StreamGap } from "@openedbot/contracts-events";
import { mergeRuntimeChangedFrames, RUNTIME_CHANGED_FRAME } from "@openedbot/contracts-events";

/** With no `id:`: a gap does not advance `Last-Event-ID`, the first replayed event will. */
export function serializeGap(gap: StreamGap): string {
  return `event: stream.gap\ndata: ${JSON.stringify(gap)}\n\n`;
}

/** With `id:`: that is its whole purpose, to advance `Last-Event-ID`. */
export function serializeCursor(position: StreamCursor): string {
  return `id: ${position.cursor}\nevent: stream.cursor\ndata: ${JSON.stringify(position)}\n\n`;
}

/** With no `id:` and outside the log: never replayed, never moves the resume cursor. */
export function serializeRuntimeChanged(frame: RuntimeChangedFrame): string {
  return `event: ${RUNTIME_CHANGED_FRAME}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * `runtime.changed` on one SSE connection (rework-flux-api step 5a). A frame
 * that cannot be written now (access check in flight, queue over its
 * threshold) is not dropped: pending frames merge into one, written as soon
 * as the connection can (`flush`, called after the access check and on the
 * heartbeat). A signal is idempotent; only its loss would freeze a screen.
 */
export function createRuntimeChangedWriter(connection: { write(frame: string): void; canWrite(): boolean }) {
  let pending: RuntimeChangedFrame | null = null;
  const flush = (): boolean => {
    if (!pending || !connection.canWrite()) return false;
    const frame = pending;
    pending = null;
    connection.write(serializeRuntimeChanged(frame));
    return true;
  };
  return {
    offer(frame: RuntimeChangedFrame): void {
      pending = mergeRuntimeChangedFrames(pending, frame);
      flush();
    },
    flush,
  };
}
