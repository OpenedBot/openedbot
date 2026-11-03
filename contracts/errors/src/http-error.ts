/**
 * L'erreur nommée qu'un cas d'usage lève et que l'API rend telle quelle.
 *
 * Elle vit dans les contrats pour que les modules métier et l'application
 * partagent la MÊME classe : `onError` la reconnaît par `instanceof`.
 *
 * Le cinquième argument porte, au choix, un `detail` court (chaîne, ex.
 * `instance_dead` pour un lien connecteur) ou un objet `details` structuré
 * (ex. `{ runId, stepKind }` derrière `BOT_BUSY`). Les deux sont rendus tels
 * quels par `onError`, jamais fusionnés.
 */
export class HttpError extends Error {
  readonly detail: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
    extra?: string | Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "HttpError";
    this.detail = typeof extra === "string" ? extra : undefined;
    this.details = extra !== undefined && typeof extra === "object" ? extra : undefined;
  }
}
