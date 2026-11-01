/**
 * One organization stream (`GET /api/events`), parsed frame by frame. Each
 * frame is `id:` (committed cursor, optional), `event:` (the envelope type) and
 * `data:` (the envelope JSON). Pre-commit deltas arrive without `id:`.
 */
import type { OrganizationEvent } from "../../../contracts/events/src/index";

/** `committed` : the frame carried an `id:` line, so it is the post-commit replay. */
export type SseFrame = { type: string; event: OrganizationEvent; receivedAt: number; committed: boolean };

export type OpenStream = { controller: AbortController; task: Promise<void> };

export async function openEventStream(input: {
  apiUrl: string;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  onFrame: (frame: SseFrame) => void;
}): Promise<OpenStream> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("sse_connect_timeout"), input.connectTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${input.apiUrl}/api/events?cursor=0`, {
      headers: { ...input.headers, Accept: "text/event-stream" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || !response.body) throw new Error(`SSE failed with HTTP ${response.status}.`);
  return { controller, task: consume(response.body, controller.signal, input.onFrame) };
}

async function consume(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const item = await reader.read();
      if (item.done) throw new Error("SSE closed unexpectedly.");
      buffer += decoder.decode(item.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const parsed = parseFrame(frame);
        if (parsed) onFrame(parsed);
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): SseFrame | null {
  let type = "";
  let data = "";
  let committed = false;
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
    else if (line.startsWith("id:")) committed = true;
  }
  if (!data || type.startsWith("stream.")) return null;
  const event = JSON.parse(data) as OrganizationEvent;
  if (typeof event.runId !== "string" || typeof event.organizationId !== "string") return null;
  return { type: type || event.type, event, receivedAt: performance.now(), committed };
}
