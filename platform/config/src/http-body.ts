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
    const raw = await request.arrayBuffer();
    if (raw.byteLength > maxBytes) {
      throw new HttpError(413, "BODY_TOO_LARGE", "Le corps JSON est trop volumineux.");
    }
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
  const raw = await request.arrayBuffer();
  if (raw.byteLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Le corps de la requête est trop volumineux.");
  }
  return new TextDecoder().decode(raw);
}
