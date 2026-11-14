import type { HermesEvent } from "./contracts";

export type ServerSentEvent = {
  id: string | null;
  event: string;
  data: string;
};

export const MAX_SSE_FRAME_BYTES = 1024 * 1024;
export const MAX_HERMES_DELTA_BYTES = 64 * 1024;
export const MAX_HERMES_STREAM_BYTES = 4 * 1024 * 1024;
export const MAX_HERMES_EVENTS = 10_000;

export type HermesSseErrorCode =
  | "HERMES_SSE_FRAME_TOO_LARGE"
  | "HERMES_SSE_DELTA_TOO_LARGE"
  | "HERMES_SSE_STREAM_TOO_LARGE"
  | "HERMES_SSE_EVENT_LIMIT";

export class HermesSseError extends Error {
  constructor(
    message: string,
    readonly code: HermesSseErrorCode,
  ) {
    super(message);
    this.name = "HermesSseError";
  }
}

export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let eventCount = 0;
  let completed = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_HERMES_STREAM_BYTES) {
          throw new HermesSseError(
            `Le flux Hermes dépasse ${MAX_HERMES_STREAM_BYTES} octets.`,
            "HERMES_SSE_STREAM_TOO_LARGE",
          );
        }
      }
      // Normalize after concatenation so a CRLF split across two chunks is
      // still recognized as a single SSE newline.
      buffer = `${buffer}${decoder.decode(value, { stream: !done })}`.replaceAll("\r\n", "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        assertFrameSize(raw);
        const frame = parseFrame(raw);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (frame) {
          eventCount += 1;
          if (eventCount > MAX_HERMES_EVENTS) {
            throw new HermesSseError(
              `Le flux Hermes dépasse ${MAX_HERMES_EVENTS} événements.`,
              "HERMES_SSE_EVENT_LIMIT",
            );
          }
          yield frame;
        }
      }

      assertFrameSize(buffer);

      if (done) {
        completed = true;
        break;
      }
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* parseHermesEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<HermesEvent> {
  for await (const frame of parseServerSentEvents(stream)) {
    if (frame.data === "[DONE]") continue;
    let value: unknown;
    try {
      value = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || typeof (value as { event?: unknown }).event !== "string") {
      continue;
    }
    if (
      (value as { event: string }).event === "message.delta" &&
      typeof (value as { delta?: unknown }).delta === "string" &&
      utf8ByteLength((value as { delta: string }).delta) > MAX_HERMES_DELTA_BYTES
    ) {
      throw new HermesSseError(
        `Un delta Hermes dépasse ${MAX_HERMES_DELTA_BYTES} octets.`,
        "HERMES_SSE_DELTA_TOO_LARGE",
      );
    }
    // Le champ SSE `id:` porte, quand il existe, le numéro de séquence du
    // journal du connecteur (`docs/CONNECTOR.md`, rejeu). Un gateway direct ne
    // l'émet pas : l'événement reste alors exactement ce qu'il était.
    const sequence = frame.id === null ? null : parseSequence(frame.id);
    yield sequence === null ? value as HermesEvent : { ...(value as HermesEvent), sequence };
  }
}

function parseSequence(id: string): number | null {
  if (!/^\d{1,15}$/.test(id)) return null;
  const sequence = Number(id);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function assertFrameSize(value: string): void {
  if (utf8ByteLength(value) > MAX_SSE_FRAME_BYTES) {
    throw new HermesSseError(
      `Une frame SSE Hermes dépasse ${MAX_SSE_FRAME_BYTES} octets.`,
      "HERMES_SSE_FRAME_TOO_LARGE",
    );
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseFrame(raw: string): ServerSentEvent | null {
  let id: string | null = null;
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length > 0 ? { id, event, data: data.join("\n") } : null;
}
