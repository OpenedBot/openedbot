import { HttpError } from "@openedbot/contracts-errors/http-error";

/** L'identifiant d'un fournisseur de modèles dans une URL de route. */
export function providerSlug(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new HttpError(400, "RUNTIME_PROVIDER_INVALID", "Identifiant de fournisseur invalide.");
  }
  return normalized;
}

/** La clé d'API d'un fournisseur : une chaîne bornée, sans caractère de contrôle. */
export function providerApiKey(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_000
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new HttpError(400, "RUNTIME_PROVIDER_KEY_INVALID", "La clé fournisseur est invalide.");
  }
  return value;
}
