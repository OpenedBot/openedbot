type ApiFailure = { status?: unknown; code?: unknown };

/**
 * An error after the send can hide a successful commit. 4xx are
 * definitive refusals; no response, 5xx and a malformed 2xx response require
 * replaying exactly the same idempotency key.
 */
export function isAmbiguousWebhookManagementFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as ApiFailure;
  return failure.status === 0 ||
    typeof failure.status === "number" && failure.status >= 500 ||
    failure.code === "API_UNAVAILABLE" || failure.code === "INVALID_RESPONSE";
}
