import { useParams } from "@tanstack/react-router";
import { create } from "zustand";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { randomId } from "../random-id";

/**
 * Bot creations in progress. « Créer » closes the sheet and opens
 * `/bot/<provisional id>` at once: the creation screen reads the name and the
 * face here while the server works, then the route is replaced by
 * the real identifier. The provisional identifier never leaves the client.
 *
 * On failure, `retry` replays the SAME request (same `clientRequestId`, 0135):
 * if the first send had in fact succeeded, the server returns that bot instead
 * of creating a second one.
 */
export type PendingBotCreation = {
  name: string;
  face: BotFaceSpec;
  error: string | null;
  retry: (() => void) | null;
  /** The real bot, from the API's response until navigation to it finishes. */
  createdBotId?: string;
};

const PENDING_PREFIX = "creating-";

const usePendingBotCreationStore = create<{
  entries: Readonly<Record<string, PendingBotCreation>>;
  /** Bots created here a moment ago: their sidebar row enters once (`useJustCreatedBot`). */
  justCreated: Readonly<Record<string, true>>;
}>()(() => ({ entries: {}, justCreated: {} }));

/** Longer than the row's entrance (280 ms), and than the roster's next render. */
const JUST_CREATED_MS = 1_000;

export function isPendingBotId(botId: string): boolean {
  return botId.startsWith(PENDING_PREFIX);
}

export function usePendingBotCreation(botId: string): PendingBotCreation | undefined {
  return usePendingBotCreationStore((state) => state.entries[botId]);
}

export function startPendingBotCreation(entry: Pick<PendingBotCreation, "name" | "face">): string {
  const id = `${PENDING_PREFIX}${randomId()}`;
  usePendingBotCreationStore.setState((state) => ({ entries: { ...state.entries, [id]: { ...entry, error: null, retry: null } } }));
  return id;
}

export function failPendingBotCreation(id: string, error: string, retry: (() => void) | null = null): void {
  usePendingBotCreationStore.setState((state) => {
    const entry = state.entries[id];
    return entry ? { entries: { ...state.entries, [id]: { ...entry, error, retry } } } : state;
  });
}

/** A retry is under way: the screen waits again instead of showing the failure. */
export function resumePendingBotCreation(id: string): void {
  usePendingBotCreationStore.setState((state) => {
    const entry = state.entries[id];
    return entry ? { entries: { ...state.entries, [id]: { ...entry, error: null, retry: null } } } : state;
  });
}

/**
 * The API answered: the provisional id now designates the real bot. Set
 * BEFORE the bot enters the cached roster, so its sidebar row is selected
 * and enters from its first frame (`useRouteBotParams`, `useJustCreatedBot`).
 */
export function linkPendingBotCreation(id: string, botId: string): void {
  usePendingBotCreationStore.setState((state) => {
    const entry = state.entries[id];
    return entry
      ? { entries: { ...state.entries, [id]: { ...entry, createdBotId: botId } }, justCreated: { ...state.justCreated, [botId]: true } }
      : state;
  });
  // The cached roster renders on a later tick than this link, and the
  // creation settles as soon as the navigation ends: the mark keeps its own clock.
  setTimeout(() => usePendingBotCreationStore.setState((state) => {
    if (!(botId in state.justCreated)) return state;
    const { [botId]: _done, ...justCreated } = state.justCreated;
    return { justCreated };
  }), JUST_CREATED_MS);
}

/**
 * The route's bot and group. On a provisional `/bot/<id>` whose bot the API
 * has created, the real bot: the navigation to its address is asynchronous,
 * and its row would otherwise appear unselected, then turn selected.
 */
export function useRouteBotParams(): { botId?: string; groupId?: string } {
  const { botId, groupId } = useParams({ strict: false }) as { botId?: string; groupId?: string };
  const created = usePendingBotCreationStore((state) => (botId ? state.entries[botId]?.createdBotId : undefined));
  return { botId: created ?? botId, groupId };
}

/** This bot was just created here: its row enters instead of popping in. */
export function useJustCreatedBot(botId: string): boolean {
  return usePendingBotCreationStore((state) => botId in state.justCreated);
}

export function settlePendingBotCreation(id: string): void {
  usePendingBotCreationStore.setState((state) => {
    if (!(id in state.entries)) return state;
    const { [id]: _settled, ...entries } = state.entries;
    return { entries };
  });
}
