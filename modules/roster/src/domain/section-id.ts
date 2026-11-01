import { isUuid } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";

/**
 * L'identifiant de section d'un corps de requête : bot comme salon. Une
 * chaîne quelconque partirait telle quelle dans une colonne `uuid` : 22P02
 * chez PostgreSQL, « Erreur interne » chez l'opérateur.
 */
export function readSectionId(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new HttpError(400, "SECTION_ID_INVALID", "La section demandée est invalide.");
  }
  return value.toLowerCase();
}
