import { createHash } from "node:crypto";
import { HermesClientError, isHermesProviderErrorCode } from "../errors";
import { record, responseInvalid } from "./shared";

const ERROR_BODY_TIMEOUT_MS = 2_000;

/** Pure protocol validators. They never perform requests or inspect client configuration. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    const milliseconds = seconds * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const at = Date.parse(normalized);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

export function providerErrorFromBody(body: unknown, status: number): HermesClientError {
  const error = record(record(body)?.error);
  const code = error?.code;
  const message = error?.message;
  if (typeof code === "string" && typeof message === "string") {
    return new HermesClientError(
      message,
      status,
      isHermesProviderErrorCode(code) ? code : "HERMES_RESPONSE_INVALID",
      { requestDelivery: "response_received" },
    );
  }
  return new HermesClientError(
    `L’hôte a refusé l’opération fournisseur (HTTP ${status}).`,
    status,
    "HERMES_RESPONSE_INVALID",
    { requestDelivery: "response_received" },
  );
}

export function upstreamDiagnostic(body: string): string | null {
  const trimmedBody = body.trim();
  if (!trimmedBody) return null;
  try {
    const parsed = JSON.parse(trimmedBody) as { message?: unknown; error?: unknown; detail?: unknown };
    const candidate = parsed.message ?? parsed.detail ?? parsed.error;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 500);
    const nested = candidate && typeof candidate === "object"
      ? (candidate as { message?: unknown }).message
      : null;
    if (typeof nested === "string" && nested.trim()) return nested.trim().slice(0, 500);
  } catch {
    // A non-JSON body has no safer structured diagnostic.
  }
  return trimmedBody.slice(0, 1_000);
}

export function diagnosticReference(status: number, diagnostic: string): string {
  return createHash("sha256").update(`${status}\n${diagnostic}`).digest("hex").slice(0, 8);
}

export function isEventStreamContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

export async function readResponseExcerpt(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  const timeout = setTimeout(() => {
    void reader.cancel("error_body_timeout").catch(() => undefined);
  }, ERROR_BODY_TIMEOUT_MS);
  try {
    while (total < maxBytes) {
      let result;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result.done) {
        finished = true;
        break;
      }
      const remaining = maxBytes - total;
      const chunk = result.value.byteLength > remaining
        ? result.value.subarray(0, remaining)
        : result.value;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (result.value.byteLength > remaining || total === maxBytes) {
        await reader.cancel().catch(() => undefined);
        finished = true;
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new TextDecoder().decode(joinChunks(chunks, total));
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw inventoryTooLarge();
  }
  if (!response.body) throw invalidInventoryJson();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw inventoryTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder().decode(joinChunks(chunks, total))) as unknown;
  } catch (error) {
    throw invalidInventoryJson(error);
  }
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function inventoryTooLarge(): HermesClientError {
  return responseInvalid("Hermes a renvoyé un inventaire trop volumineux.");
}

function invalidInventoryJson(cause?: unknown): HermesClientError {
  return new HermesClientError(
    "Hermes a renvoyé un inventaire non JSON.",
    502,
    "HERMES_RESPONSE_INVALID",
    { requestDelivery: "response_received", cause },
  );
}
