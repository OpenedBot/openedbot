import { useParams } from "@tanstack/react-router";
import { create } from "zustand";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { randomId } from "../random-id";

/**
 * Les créations de bot en cours. « Créer » ferme la feuille et ouvre tout
 * de suite `/bot/<id provisoire>` : l'écran de création lit ici le nom et le
 * visage pendant que le serveur travaille, puis la route est remplacée par
 * le vrai identifiant. L'identifiant provisoire ne quitte jamais le client.
 *
 * En échec, `retry` rejoue la MÊME demande (même `clientRequestId`, 0135) :
 * si le premier envoi avait en fait abouti, le serveur rend ce bot-là au lieu
 * d'en créer un second.
 */
export type PendingBotCreation = {
  name: string;
  face: BotFaceSpec;
  error: string | null;
  retry: (() => void) | null;
  /** Le vrai bot, dès la réponse de l'API et jusqu'à la fin de la navigation vers lui. */
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

/** Ce bot vient d'être créé ici : sa ligne entre au lieu de surgir. */
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
