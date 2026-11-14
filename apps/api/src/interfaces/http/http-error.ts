/**
 * Facade: `HttpError` lives in `@openedbot/contracts-errors/http-error` and the
 * bounded body reads in `@openedbot/platform-config/http-body`, so that
 * the modules and the link gateway throw the same class as the one
 * `app.onError` recognizes.
 */
export { HttpError } from "@openedbot/contracts-errors/http-error";
export { assertPassword, assertString, boundedTextBody, DEFAULT_MAX_JSON_BODY_BYTES, jsonBody } from "@openedbot/platform-config/http-body";
