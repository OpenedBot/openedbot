import { useSyncExternalStore } from "react";
import type { OverlaySettingsPath } from "./settings-overlay";

/**
 * Réglages › Apparence › Ouvrir les réglages : en fenêtre (la modale posée
 * au-dessus de l'écran courant, qui reste monté derrière) ou en page (la carte
 * principale du cadre, menu des rubriques à gauche). Une préférence de
 * l'appareil, comme la taille du texte. Bureau seulement : sur téléphone les
 * réglages restent une pile d'écrans.
 */
export type SettingsDisplay = "modal" | "page";

export const DEFAULT_SETTINGS_DISPLAY: SettingsDisplay = "modal";
const STORAGE_KEY = "ohb:settings-display";

const listeners = new Set<() => void>();

export function isSettingsDisplay(value: unknown): value is SettingsDisplay {
  return value === "modal" || value === "page";
}

export function readSettingsDisplay(): SettingsDisplay {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isSettingsDisplay(value) ? value : DEFAULT_SETTINGS_DISPLAY;
  } catch {
    // Stockage refusé : la fenêtre, sans bloquer l'app.
    return DEFAULT_SETTINGS_DISPLAY;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Un autre onglet change le mode : on le suit.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/**
 * Retient le mode et prévient les abonnés. Un stockage refusé ne retient rien
 * mais l'onglet courant change quand même de mode jusqu'au rechargement.
 */
let sessionFallback: SettingsDisplay | null = null;

export function setSettingsDisplay(display: SettingsDisplay) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, display);
    sessionFallback = null;
  } catch {
    sessionFallback = display;
  }
  for (const listener of listeners) listener();
}

function snapshot(): SettingsDisplay {
  return sessionFallback ?? readSettingsDisplay();
}

export function useSettingsDisplay(): SettingsDisplay {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_SETTINGS_DISPLAY);
}

/**
 * Le passage page → fenêtre : la page quitte la route des réglages pour
 * l'écran d'où l'on venait, et c'est le cadre de l'app, une fois monté, qui
 * rouvre la même rubrique en surcouche (`SettingsOverlayHost`). Une valeur
 * consommée une seule fois.
 */
let pendingOverlay: OverlaySettingsPath | null = null;

export function queueSettingsOverlay(path: OverlaySettingsPath) {
  pendingOverlay = path;
}

export function takeQueuedSettingsOverlay(): OverlaySettingsPath | null {
  const path = pendingOverlay;
  pendingOverlay = null;
  return path;
}
