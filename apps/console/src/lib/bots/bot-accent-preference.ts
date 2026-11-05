import { useSyncExternalStore } from "react";

/**
 * Réglages › Apparence › Accent d'une conversation, comme le réglage
 * « Accent : Couleur du Bot » de Grok Bot : dans le fil d'un bot, boutons,
 * interrupteurs et focus prennent la couleur de son visage (`bot`), ou
 * gardent l'accent de l'app (`app`). Une préférence de l'appareil, comme
 * la taille du texte.
 */
export const BOT_ACCENT_MODES = ["bot", "app"] as const;
export type BotAccentMode = (typeof BOT_ACCENT_MODES)[number];

export const DEFAULT_BOT_ACCENT_MODE: BotAccentMode = "bot";
const STORAGE_KEY = "openedbot:bot-accent";

const listeners = new Set<() => void>();

function isMode(value: unknown): value is BotAccentMode {
  return typeof value === "string" && (BOT_ACCENT_MODES as readonly string[]).includes(value);
}

function read(): BotAccentMode {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isMode(value) ? value : DEFAULT_BOT_ACCENT_MODE;
  } catch {
    // Stockage refusé : le mode par défaut, sans bloquer l'app.
    return DEFAULT_BOT_ACCENT_MODE;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Changé dans un autre onglet : on le suit.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function setBotAccentMode(mode: BotAccentMode) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // Stockage plein ou refusé : rien n'est retenu, le mode reste celui lu.
    return;
  }
  for (const listener of listeners) listener();
}

export function useBotAccentMode(): BotAccentMode {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_BOT_ACCENT_MODE);
}
