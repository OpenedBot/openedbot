import { useSyncExternalStore } from "react";

// The shortlist while choosing: starred templates, kept in this browser.
const KEY = "openedbot-lab:favorites";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function useFavorites(): [Set<string>, (name: string) => void] {
  const raw = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
  );
  const favorites = new Set<string>(JSON.parse(raw) as string[]);
  const toggle = (name: string): void => {
    const next = new Set(favorites);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    window.localStorage.setItem(KEY, JSON.stringify([...next].sort()));
    for (const listener of listeners) listener();
  };
  return [favorites, toggle];
}
