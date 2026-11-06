import { useSyncExternalStore } from "react";

/**
 * Réglages › Apparence › Taille du texte (10 à 14 px), comme la « Taille du
 * texte » d'Escape : une préférence de l'appareil, pour toute l'app.
 *
 * La console est écrite pour un texte courant de 14 px. Un autre choix la
 * zoome au lieu de réécrire ses tailles : texte, icônes, marges et contrôles
 * gardent leurs proportions.
 *
 * - App de bureau : toute la WebView est zoomée par la coque, menus et
 *   fenêtres compris. La console pose le facteur voulu sur
 *   `<html data-openedbot-text-zoom>` ; `lib/platform/tauri-shell.ts` le
 *   transmet et, une fois appliqué, pose `data-native-zoom` et
 *   `--openedbot-native-zoom` sur `<html>` (`native-titlebar.css` s'en sert pour la
 *   place des boutons du système, qui ne zooment pas).
 * - Navigateur : une page ne peut pas régler son propre zoom (le zoom du
 *   navigateur reste à l'utilisateur), et un `zoom` CSS sur la racine
 *   décalerait chaque menu positionné. La taille reste celle du navigateur.
 */
export const TEXT_SIZES = [10, 11, 12, 13, 14] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** 14 px par défaut : un zoom de 1, comme Grok Bot (texte courant 14/20). */
export const DEFAULT_TEXT_SIZE: TextSize = 14;
/** Le texte courant pour lequel la console est écrite : cette taille vaut un zoom de 1. */
const DESIGN_TEXT_SIZE = 14;
/** La clé d'avant l'extension à toute l'app : le choix déjà fait est gardé. */
const STORAGE_KEY = "openedbot:settings-text-size";
/** Lu par `lib/platform/tauri-shell.ts` : renommer l'un sans l'autre coupe le zoom. */
export const TEXT_ZOOM_ATTRIBUTE = "data-openedbot-text-zoom";

const listeners = new Set<() => void>();

function isTextSize(value: unknown): value is TextSize {
  return typeof value === "number" && (TEXT_SIZES as readonly number[]).includes(value);
}

function read(): TextSize {
  try {
    const value = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
    return isTextSize(value) ? value : DEFAULT_TEXT_SIZE;
  } catch {
    // Stockage refusé : la taille par défaut, sans bloquer l'app.
    return DEFAULT_TEXT_SIZE;
  }
}

/** Le facteur de zoom pour une taille. */
export function textZoom(size: TextSize): number {
  return size / DESIGN_TEXT_SIZE;
}

/** Pose le facteur voulu sur `<html>`, où la coque native le lit. */
function paint(doc: Document | undefined = globalThis.document) {
  doc?.documentElement.setAttribute(TEXT_ZOOM_ATTRIBUTE, String(textZoom(read())));
}

/**
 * À appeler avant le premier rendu : la coque zoome dès le chargement, et
 * suit un changement fait dans une autre fenêtre (événement `storage`).
 */
export function applyStoredTextSize(doc: Document = document) {
  paint(doc);
  doc.defaultView?.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) paint(doc);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Un autre onglet ou la fenêtre de bureau change la taille : on la suit.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function setTextSize(size: TextSize) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(size));
  } catch {
    // Stockage plein ou refusé : rien n'est retenu, la taille reste celle lue.
    return;
  }
  paint();
  for (const listener of listeners) listener();
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_TEXT_SIZE);
}
