import { create } from "zustand";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { randomId } from "./random-id";

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
};

const PENDING_PREFIX = "creating-";

const usePendingBotCreationStore = create<{ entries: Readonly<Record<string, PendingBotCreation>> }>()(() => ({ entries: {} }));

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

export function settlePendingBotCreation(id: string): void {
  usePendingBotCreationStore.setState((state) => {
    if (!(id in state.entries)) return state;
    const { [id]: _settled, ...entries } = state.entries;
    return { entries };
  });
}
