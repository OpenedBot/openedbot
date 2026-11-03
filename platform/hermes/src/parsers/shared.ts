import type {
  HermesProviderOauthStatus,
  HermesProviderVerification,
} from "../contracts";
import { HermesClientError } from "../errors";

/**
 * Bornes des listes de l'hôte. Elles ne protègent pas d'un hôte malveillant (
 * il sert déjà les runs), mais d'un hôte cassé : une liste sans fin rendue
 * telle quelle fait fondre le navigateur d'un opérateur, pas le serveur.
 */
export const MAX_HOST_LIST = 256;
export const PROVIDER_VERIFICATIONS: ReadonlySet<string> = new Set<HermesProviderVerification>(["confirmed", "denied", "unverified"]);
export const PROVIDER_OAUTH_STATUSES: ReadonlySet<string> = new Set<HermesProviderOauthStatus>([
  "starting", "pending", "connected", "failed", "cancelled",
]);

export function invalidProviderResponse(cause?: unknown): HermesClientError {
  return new HermesClientError(
    "L’hôte a renvoyé une réponse fournisseur invalide.",
    502,
    "HERMES_RESPONSE_INVALID",
    { requestDelivery: "response_received", ...(cause === undefined ? {} : { cause }) },
  );
}

export function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function responseInvalid(message: string, cause?: unknown): HermesClientError {
  return new HermesClientError(message, 502, "HERMES_RESPONSE_INVALID", {
    requestDelivery: "response_received",
    ...(cause === undefined ? {} : { cause }),
  });
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
