import { useSyncExternalStore } from "react";
import { nativeUpdates } from "./native-updates";

/** The API's code (`client-version.ts`): the desktop app is older than the minimum served. */
export const CLIENT_UPDATE_REQUIRED = "CLIENT_UPDATE_REQUIRED";

/** The site's download page, per language (`openedbot-site`, `/download`). */
export function desktopDownloadUrl(locale: "fr" | "en"): string {
  return locale === "fr" ? "https://openedbot.app/fr/download" : "https://openedbot.app/download";
}

export type ClientUpdateState = { minVersion: string | null; version: string | null };

let state: ClientUpdateState | null = null;
const listeners = new Set<() => void>();

/**
 * Remembers that a `426 CLIENT_UPDATE_REQUIRED` response arrived. One
 * is enough: the embedded console is useless until it is
 * updated, and the screen says so once instead of errors on every screen.
 */
export function reportClientUpdateRequired(details: unknown): void {
  if (state) return;
  const read = (key: string) => {
    const value = details && typeof details === "object" ? (details as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? value : null;
  };
  state = { minVersion: read("minVersion"), version: read("version") };
  for (const listener of listeners) listener();
  // The Tauri app switches to « mise à jour requise » and looks for the update
  // at once: its screen then offers to install it, not only the link.
  const minimum = state.minVersion && /^\d{1,4}(\.\d{1,4}){0,2}$/.test(state.minVersion) ? state.minVersion : null;
  void nativeUpdates()?.reportRequired(minimum).catch(() => undefined);
}

/**
 * A `fetch` that itself reports a `426 CLIENT_UPDATE_REQUIRED`. For the
 * streams (events, desk) that do not go through `request()`: without it,
 * the app would lose realtime without ever showing the update screen.
 * The response is returned as-is; the body read is a copy.
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
  // The loops only call `fetch(url, init)`: the rest of `typeof fetch` is unused.
  return reporting as typeof fetch;
}

/** True once a 426 has arrived: no stream must reopen. */
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
