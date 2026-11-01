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
