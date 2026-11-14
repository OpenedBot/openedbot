import { useSyncExternalStore } from "react";

/**
 * Settings › Appearance › a conversation's accent, like the reference app's
 * « Accent : Couleur du Bot » setting: in a bot's thread, buttons,
 * switches and focus take its face's color (`bot`), or
 * keep the app accent (`app`). A device preference, like
 * the text size.
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
    // Storage refused: the default mode, without blocking the app.
    return DEFAULT_BOT_ACCENT_MODE;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Changed in another tab: we follow it.
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
    // Storage full or refused: nothing is kept, the mode stays the one read.
    return;
  }
  for (const listener of listeners) listener();
}

export function useBotAccentMode(): BotAccentMode {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_BOT_ACCENT_MODE);
}
