/**
 * What an UNEXPECTED error says on screen.
 *
 * « Erreur interne. Référence : X » was true and useless: the operator who
 * saw « HTTP 500 » had nothing to read, and the cause was sleeping in the
 * log. An unexpected error stays a 500 (the contract does not change),
 * but its message names the cause in French, and outside production it also
 * carries the raw text of the error: a developer must not have to
 * open the log to read « column memory_extract_enabled does not
 * exist ».
 */

type PgLike = Partial<{ code: string; constraint: string; detail: string; message: string; name: string; errno: string | number }>;

const PG_CAUSES: Record<string, string> = {
  "42703": "une colonne attendue n’existe pas en base (migration manquante ou schéma en avance)",
  "42P01": "une table attendue n’existe pas en base (migration manquante)",
  "42883": "une fonction attendue n’existe pas en base",
  "23505": "la base a refusé un doublon",
  "23503": "la base a refusé une référence vers une ligne absente",
  "23514": "la base a refusé une valeur hors contrainte",
  "23502": "la base a refusé une valeur manquante",
  "22P02": "la base a reçu une valeur mal formée",
  "40001": "la base a annulé la transaction (conflit de sérialisation) ; réessayez",
  "40P01": "la base a annulé la transaction (interblocage) ; réessayez",
  "57014": "la base a interrompu une requête trop longue",
  "53300": "la base n’a plus de connexion disponible",
  "28P01": "la base a refusé l’identifiant de l’API",
  "3D000": "la base de données nommée n’existe pas",
};

const NETWORK_CAUSES: Record<string, string> = {
  ECONNREFUSED: "un service dont l’API dépend est injoignable",
  ECONNRESET: "un service dont l’API dépend a coupé la connexion",
  ETIMEDOUT: "un service dont l’API dépend n’a pas répondu à temps",
  ENOTFOUND: "un service dont l’API dépend est introuvable (DNS)",
};

/** The cause in French, without technical detail: what is read even in production. */
export function unhandledErrorCause(error: unknown): string {
  const like = (error ?? {}) as PgLike;
  const code = typeof like.code === "string" ? like.code : typeof like.errno === "string" ? like.errno : "";
  if (code && PG_CAUSES[code]) return PG_CAUSES[code]!;
  if (code && NETWORK_CAUSES[code]) return NETWORK_CAUSES[code]!;
  if (code.startsWith("08")) return "la base de données est injoignable";
  if (code.startsWith("42")) return "une requête vers la base est invalide";
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return "une erreur de programme dans l’API";
  }
  if (error instanceof SyntaxError) return "une réponse ou un fichier mal formé";
  return "une erreur inattendue dans l’API";
}

/** The raw text, bounded, without a line break: for the developer, never in production. */
export function unhandledErrorRaw(error: unknown): string {
  const like = (error ?? {}) as PgLike;
  const parts = [
    String(error instanceof Error ? error.message : error),
    typeof like.detail === "string" ? like.detail : "",
    typeof like.constraint === "string" ? `constraint ${like.constraint}` : "",
  ].filter(Boolean);
  return parts.join(" ; ").replace(/\s+/g, " ").slice(0, 400);
}

export type UnhandledErrorBody = {
  code: "INTERNAL_ERROR";
  message: string;
  details: { cause: string; reference: string; pgCode?: string; raw?: string };
};

/**
 * The JSON body of a 500: the translated cause and the reference always; the
 * raw text only outside production, where nobody but the
 * developer reads it.
 */
export function unhandledErrorBody(error: unknown, requestId: string, environment: string): UnhandledErrorBody {
  const cause = unhandledErrorCause(error);
  const raw = environment === "production" ? undefined : unhandledErrorRaw(error);
  const like = (error ?? {}) as PgLike;
  const pgCode = typeof like.code === "string" && /^[0-9A-Z]{5}$/.test(like.code) ? like.code : undefined;
  return {
    code: "INTERNAL_ERROR",
    message: raw
      ? `Erreur interne : ${cause}. ${raw} (référence ${requestId})`
      : `Erreur interne : ${cause}. Référence : ${requestId}`,
    details: { cause, reference: requestId, ...(pgCode ? { pgCode } : {}), ...(raw ? { raw } : {}) },
  };
}
