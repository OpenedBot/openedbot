import { useSyncExternalStore } from "react";

/**
 * The ask_user questions the operator dismissed (the card's « x »,
 * like the reference app). The run is already finished when the card appears: dismissing
 * tells the model nothing, the card only folds into one line. The choice
 * lives in this browser, per run, bounded to the most recent.
 */
const STORAGE_KEY = "openedbot.askUser.dismissedRuns";
const MAX_RUNS = 200;

const listeners = new Set<() => void>();
let cache: readonly string[] | null = null;

function read(): readonly string[] {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Unreadable value: starting over from scratch reopens at worst only cards.
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
  // Reread just before writing: another tab may have dismissed a question
  // in the meantime, and overwriting it would reopen it.
  cache = null;
  const current = read();
  if (current.includes(runId)) return;
  cache = [...current, runId].slice(-MAX_RUNS);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or refused: the card stays dismissed for this session.
  }
  emit();
}

const EMPTY: readonly string[] = [];

/** The runs whose question was dismissed, reread on every change. */
export function useDismissedAskUserRuns(): readonly string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
