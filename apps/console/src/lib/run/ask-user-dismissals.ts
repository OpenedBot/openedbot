import { useSyncExternalStore } from "react";

/**
 * Les questions ask_user que l'opérateur a ignorées (le « x » de la carte,
 * comme Grok Bot). Le run est déjà terminé quand la carte s'affiche : ignorer
 * ne dit rien au modèle, la carte se replie seulement en une ligne. Le choix
 * vit dans ce navigateur, par run, borné aux plus récents.
 */
const STORAGE_KEY = "ohb.askUser.dismissedRuns";
const MAX_RUNS = 200;

const listeners = new Set<() => void>();
let cache: readonly string[] | null = null;

function read(): readonly string[] {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Valeur illisible : la repartir de zéro ne rouvre au pire que des cartes.
    cache = [];
  }
  return cache;
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cache = null;
    listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function dismissAskUser(runId: string) {
  // Relu juste avant d'écrire : un autre onglet a pu ignorer une question
  // entre-temps, et l'écraser la rouvrirait.
  cache = null;
  const current = read();
  if (current.includes(runId)) return;
  cache = [...current, runId].slice(-MAX_RUNS);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Stockage plein ou refusé : la carte reste ignorée pour cette session.
  }
  emit();
}

const EMPTY: readonly string[] = [];

/** Les runs dont la question a été ignorée, relus à chaque changement. */
export function useDismissedAskUserRuns(): readonly string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
