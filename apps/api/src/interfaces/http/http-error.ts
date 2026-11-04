/**
 * Façade : `HttpError` vit dans `@openedbot/contracts-errors/http-error` et les
 * lectures bornées du corps dans `@openedbot/platform-config/http-body`, pour que
 * les modules et la passerelle du lien lèvent la même classe que celle que
 * `app.onError` reconnaît.
 */
export { HttpError } from "@openedbot/contracts-errors/http-error";
export { assertPassword, assertString, boundedTextBody, DEFAULT_MAX_JSON_BODY_BYTES, jsonBody } from "@openedbot/platform-config/http-body";
