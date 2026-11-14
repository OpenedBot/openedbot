import type { RelayRequest } from "@openedbot/hermes";
import { RELAY_FORWARDED_RESPONSE_HEADERS } from "@openedbot/contracts-connector";

const CREATION_PATH = /^(?:\/p\/[a-z0-9][a-z0-9_-]{0,62})?\/v1\/runs$/;

/**
 * Les en-têtes d'un `res` que le lien relaie. Lève si `Headers` en refuse un
 * (NUL, nom invalide) : l'appelant règle alors la requête, sans rien livrer.
 */
export function forwardedResponseHeaders(rawHeaders: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (RELAY_FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

export function isCreationRequest(request: RelayRequest): boolean {
  if (request.method.toUpperCase() !== "POST") return false;
  const path = request.path.split("?")[0] ?? "";
  return CREATION_PATH.test(path);
}

export function headerValue(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && value.trim()) return value.trim();
  }
  return null;
}
