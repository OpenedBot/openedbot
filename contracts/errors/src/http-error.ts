/**
 * The named error a use case throws and that the API returns as is.
 *
 * It lives in the contracts so that the business modules and the application
 * share the SAME class: `onError` recognizes it by `instanceof`.
 *
 * The fifth argument carries, as chosen, a short `detail` (string, e.g.
 * `instance_dead` for a connector link) or a structured `details` object
 * (e.g. `{ runId, stepKind }` behind `BOT_BUSY`). Both are returned as
 * is by `onError`, never merged.
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
