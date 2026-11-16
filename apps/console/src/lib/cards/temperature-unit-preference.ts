import { useSyncExternalStore } from "react";
import type { TemperatureUnit } from "./weather-model";

/**
 * The °C / °F choice of the weather cards: a device preference, like the text
 * size. It applies to every card at once and wins over any payload, which is
 * always metric. Only the cards subscribe, so a toggle re-renders them and
 * nothing else in the thread.
 */
export const DEFAULT_TEMPERATURE_UNIT: TemperatureUnit = "celsius";
const STORAGE_KEY = "openedbot:temperature-unit";

const listeners = new Set<() => void>();
/** The choice made in this session when storage refuses to keep it. */
let unsaved: TemperatureUnit | null = null;

function isUnit(value: unknown): value is TemperatureUnit {
  return value === "celsius" || value === "fahrenheit";
}

function read(): TemperatureUnit {
  if (unsaved) return unsaved;
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isUnit(value) ? value : DEFAULT_TEMPERATURE_UNIT;
  } catch {
    // Storage refused: the default unit, without blocking the card.
    return DEFAULT_TEMPERATURE_UNIT;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Changed in another tab: follow it.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function setTemperatureUnit(unit: TemperatureUnit) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, unit);
    unsaved = null;
  } catch {
    // Storage full or refused: the choice holds for this session only.
    unsaved = unit;
  }
  for (const listener of listeners) listener();
}

export function useTemperatureUnit(): TemperatureUnit {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_TEMPERATURE_UNIT);
}
