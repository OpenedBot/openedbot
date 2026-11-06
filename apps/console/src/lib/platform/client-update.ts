import { useSyncExternalStore } from "react";
import { nativeUpdates } from "./native-updates";

/** Le code de l'API (`client-version.ts`) : l'app de bureau est plus vieille que le minimum servi. */
export const CLIENT_UPDATE_REQUIRED = "CLIENT_UPDATE_REQUIRED";

/** La page de téléchargement du site, par langue (`openedbot-site`, `/download`). */
export function desktopDownloadUrl(locale: "fr" | "en"): string {
  return locale === "fr" ? "https://openedbot.app/fr/download" : "https://openedbot.app/download";
}

export type ClientUpdateState = { minVersion: string | null; version: string | null };

let state: ClientUpdateState | null = null;
const listeners = new Set<() => void>();

/**
 * Retient qu'une réponse `426 CLIENT_UPDATE_REQUIRED` est arrivée. Une seule
 * suffit : la console embarquée ne sert plus à rien tant qu'elle n'est pas
 * mise à jour, l'écran le dit une fois au lieu d'erreurs sur chaque écran.
 */
export function reportClientUpdateRequired(details: unknown): void {
  if (state) return;
  const read = (key: string) => {
    const value = details && typeof details === "object" ? (details as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? value : null;
  };
  state = { minVersion: read("minVersion"), version: read("version") };
  for (const listener of listeners) listener();
  // L'app Tauri passe en « mise à jour requise » et cherche la mise à jour
  // aussitôt : son écran propose alors de l'installer, pas seulement le lien.
  const minimum = state.minVersion && /^\d{1,4}(\.\d{1,4}){0,2}$/.test(state.minVersion) ? state.minVersion : null;
  void nativeUpdates()?.reportRequired(minimum).catch(() => undefined);
}

/**
 * Un `fetch` qui signale lui-même un `426 CLIENT_UPDATE_REQUIRED`. Pour les
 * flux (événements, guichet) qui ne passent pas par `request()` : sans lui,
 * l'app perdrait le temps réel sans jamais montrer l'écran de mise à jour.
 * La réponse est rendue telle quelle ; le corps lu est une copie.
 */
export function reportingClientUpdate(fetchImpl: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>): typeof fetch {
  const reporting = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await fetchImpl(input, init);
    if (response.status === 426) {
      const body = await response.clone().json().catch(() => null) as { error?: { code?: unknown; details?: unknown } } | null;
      if (body?.error?.code === CLIENT_UPDATE_REQUIRED) reportClientUpdateRequired(body.error.details);
    }
    return response;
  };
  // Les boucles n'appellent que `fetch(url, init)` : le reste de `typeof fetch` ne sert pas.
  return reporting as typeof fetch;
}

/** Vrai dès qu'un 426 est arrivé : plus aucun flux ne doit se rouvrir. */
export function isClientUpdateRequired(): boolean {
  return state !== null;
}

export function useClientUpdateRequired(): ClientUpdateState | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => state,
    () => null,
  );
}

/** Tests only. */
export function resetClientUpdateRequired(): void {
  state = null;
  for (const listener of listeners) listener();
}
