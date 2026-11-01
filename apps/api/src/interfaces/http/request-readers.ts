import { HttpError } from "./http-error";

/** Le secret d'un en-tête `Authorization: Bearer <secret>`, sinon `null`. */
export function readBearer(value: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? "");
  return match?.[1] ?? null;
}

/** Le curseur d'un flux du guichet de support (`cursor` ou `Last-Event-ID`) : un entier positif ou nul. */
export function readCursor(value: string | undefined): number {
  const cursor = Number(value ?? "0");
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new HttpError(400, "SUPPORT_CURSOR_INVALID", "Le curseur du flux est invalide.");
  }
  return cursor;
}

/**
 * Une clé absente est acceptée : le premier envoi d'un visiteur ne doit pas
 * échouer parce que son navigateur n'a pas su en fabriquer une. Une clé
 * présente mais difforme est refusée, elle : elle prétendrait protéger un
 * rejeu sans le faire.
 */
export function readIdempotencyKey(header: string | undefined): string | null {
  const value = header?.trim();
  if (!value) return null;
  if (value.length < 8 || value.length > 200) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "La clé d’idempotence est invalide.");
  }
  return value;
}
