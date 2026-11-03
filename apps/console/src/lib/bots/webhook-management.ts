type ApiFailure = { status?: unknown; code?: unknown };

/**
 * Une erreur après l'envoi peut cacher un commit réussi. Les 4xx sont des
 * refus définitifs; absence de réponse, 5xx et réponse 2xx malformée exigent
 * de rejouer exactement la même clé d'idempotence.
 */
export function isAmbiguousWebhookManagementFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as ApiFailure;
  return failure.status === 0 ||
    typeof failure.status === "number" && failure.status >= 500 ||
    failure.code === "API_UNAVAILABLE" || failure.code === "INVALID_RESPONSE";
}
