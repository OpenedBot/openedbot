import { HttpError } from "@openedbot/contracts-errors/http-error";

/**
 * JSON endpoints accept metadata and small message payloads only.  The Bun
 * server also applies this limit before routing, but keeping the guard here is
 * important for tests and for adapters that call a Hono handler directly.
 */
export const DEFAULT_MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;

export function assertString(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== "string") throw new HttpError(400, "VALIDATION_ERROR", `${name} est requis.`);
  const result = value.trim();
  if (result.length < (options.min ?? 1) || result.length > (options.max ?? 10_000)) {
    throw new HttpError(400, "VALIDATION_ERROR", `${name} a une longueur invalide.`);
  }
  return result;
}

/**
 * A password exactly as typed: type and length are checked, no character is
 * dropped. `assertString` trims, which would make a password hashed raw (or
 * one with meaningful edge spaces) impossible to verify.
 */
export function assertPassword(value: unknown, name: string, options: { max?: number } = {}): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, "VALIDATION_ERROR", `${name} est requis.`);
  if (value.length > (options.max ?? 1_024)) throw new HttpError(400, "VALIDATION_ERROR", `${name} a une longueur invalide.`);
  return value;
}

export async function jsonBody(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Le corps JSON est trop volumineux.");
  }
  try {
    const raw = await readBoundedBytes(request, maxBytes, "Le corps JSON est trop volumineux.");
    const value = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_JSON", "Le corps JSON est invalide.");
  }
}

/** Bounded equivalent of Request.text() for signed webhook payloads. */
export async function boundedTextBody(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Le corps de la requête est trop volumineux.");
  }
  const tooLarge = "Le corps de la requête est trop volumineux.";
  return new TextDecoder().decode(await readBoundedBytes(request, maxBytes, tooLarge));
}

/**
 * Lit le corps en comptant les octets au fil du flux : sans `Content-Length`
 * (chunked), la borne tombe dès qu'elle est dépassée, le flux est annulé, et
 * ni l'allocation ni l'attente ne vont jusqu'à la fin d'un corps trop gros.
 */
async function readBoundedBytes(request: Request, maxBytes: number, tooLargeMessage: string): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body_too_large").catch(() => undefined);
        throw new HttpError(413, "BODY_TOO_LARGE", tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
