/**
 * Chemins jamais écrits en clair dans un log. La liste est exportée pour être
 * vérifiable par un test : une redaction qu'on ne peut pas prouver est une
 * redaction qu'on croit avoir. Elle couvre les en-têtes porteurs de session
 * (`authorization`, `cookie`, `set-cookie`) et, en profondeur (`*.`), les
 * champs de secret qui traversent les objets qu'on logue.
 */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.token",
  "*.claimCode",
  "*.sessionToken",
  "*.authorization",
  "*.cookie",
] as const;

/** Marqueur substitué à la valeur d'un chemin rédigé. */
export const LOG_REDACT_CENSOR = "[redacted]";

/** Option `redact` de Pino, partagée par le singleton et le handler de test. */
export const logRedact = { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR };

/**
 * Routes dont un segment est un jeton porteur : le détenir suffit à consulter,
 * voire accepter, l'invitation. `/api/invite/<genre>/<jeton>` couvre le cœur
 * et les anciens chemins que des plug-ins redirigent ; `/api/pro/<plug-in>/invite/<jeton>`
 * les invitations des plug-ins. Le reste du chemin reste lisible, le jeton
 * jamais, quel que soit le statut de la réponse.
 */
const SECRET_PATH_PATTERNS = [
  /^(\/api\/invite\/[^/]+\/)[^/]+/,
  /^(\/api\/pro\/[^/]+\/invite\/)[^/]+/,
] as const;

/** Le chemin brut, son segment secret remplacé par `LOG_REDACT_CENSOR`. */
export function redactSecretPath(path: string): string {
  for (const pattern of SECRET_PATH_PATTERNS) {
    if (pattern.test(path)) return path.replace(pattern, `$1${LOG_REDACT_CENSOR}`);
  }
  return path;
}
