import { isUuid } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";

export const TOOL_ERROR_LIMIT_DEFAULT = 20;
export const TOOL_ERROR_LIMIT_MAX = 50;

export function readToolErrorLimit(value: string | null): number {
  if (value === null || value === "") return TOOL_ERROR_LIMIT_DEFAULT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > TOOL_ERROR_LIMIT_MAX) {
    throw new HttpError(400, "TOOL_ERROR_LIMIT_INVALID", "La taille de page est invalide.");
  }
  return parsed;
}


export function readToolErrorCursor(value: string | null): { occurredAt: string; id: string } | null {
  if (value === null || value === "") return null;
  const separator = value.lastIndexOf("|");
  const occurredAt = separator > 0 ? value.slice(0, separator) : "";
  const id = separator > 0 ? value.slice(separator + 1) : "";
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt)) || !isUuid(id)) {
    throw new HttpError(400, "TOOL_ERROR_CURSOR_INVALID", "Le curseur est invalide.");
  }
  return { occurredAt, id };
}
