import type { ApiEnvironment } from "./api-config";

/** La dernière release stable publiée par Hermes (API GitHub, sans jeton). */
export const DEFAULT_HERMES_UPSTREAM_RELEASES_URL = "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest";

/**
 * Une URL de releases lue dans l'environnement : `off` coupe la lecture, vide
 * prend `fallback` en production seulement, sinon une URL https.
 */
export function readHttpsUrlDefault(value: string | undefined, environment: ApiEnvironment, fallback: string, name: string): string | null {
  const text = value?.trim() ?? "";
  if (text === "off") return null;
  if (text === "") return environment === "production" ? fallback : null;
  if (!text.startsWith("https://")) throw new Error(`${name} doit être une URL https (ou off).`);
  return text;
}
