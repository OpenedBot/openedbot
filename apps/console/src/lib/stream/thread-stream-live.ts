import type { StoredProductEvent } from "@openedbot/contracts-events";
import { snapshotRefreshAfterEvent } from "@openedbot/conversation/domain/thread-snapshot-mutations";

const DEDUPE_WINDOW = 1_000;

export type LiveEventIdentity = {
  organizationId: string;
  /** Absent sur un fan-out avant commit : ce n'est pas une position de reprise. */
  cursor?: number;
  runId: string;
  sequence: number;
};

export type LiveDedupe = {
  cursors: Set<number>;
  /** `(runId, sequence)` → curseur de la copie vue. */
  runSequences: Map<string, number>;
};

export function createLiveDedupe(): LiveDedupe {
  return { cursors: new Set(), runSequences: new Map() };
}

export function resetLiveDedupe(state: LiveDedupe): void {
  state.cursors.clear();
  state.runSequences.clear();
}

/**
 * Livrer cet événement aux écrans, ou l'ignorer.
 *
 * La bulle se déduplique sur `(runId, sequence)` : un fan-out anticipé
 * puis le rejeu durable du même événement ne s'ajoutent pas deux
 * fois. Le curseur de reprise reste celui du log (`event.cursor`), y compris
 * quand la copie est déjà connue, ce n'est pas la clé d'affichage.
 */
export function acceptLiveEvent(
  state: LiveDedupe,
  event: LiveEventIdentity,
  organizationId: string,
  streamCursor: number,
): { deliver: boolean; streamCursor: number } {
  if (event.organizationId !== organizationId) return { deliver: false, streamCursor };
  const key = `${event.runId}:${event.sequence}`;
  const cursor = typeof event.cursor === "number" && Number.isSafeInteger(event.cursor) ? event.cursor : null;
  const duplicate = (cursor !== null && state.cursors.has(cursor)) || state.runSequences.has(key);
  const nextCursor = cursor !== null && cursor > streamCursor ? cursor : streamCursor;
  if (!duplicate) {
    if (cursor !== null) state.cursors.add(cursor);
    state.runSequences.set(key, cursor ?? streamCursor);
  } else if (cursor !== null) {
    const seen = state.runSequences.get(key);
    if (seen === undefined || cursor > seen) state.runSequences.set(key, cursor);
    state.cursors.add(cursor);
  }
  const floor = nextCursor - DEDUPE_WINDOW;
  for (const seen of state.cursors) if (seen < floor) state.cursors.delete(seen);
  for (const [seenKey, seenCursor] of state.runSequences) {
    if (seenCursor < floor) state.runSequences.delete(seenKey);
  }
  return { deliver: !duplicate, streamCursor: nextCursor };
}

/** `stream.cursor` : le fil ouvert peut se taire, la reprise avance quand même. */
export function advanceStreamCursor(current: number, cursor: number): number {
  return Number.isSafeInteger(cursor) && cursor > current ? cursor : current;
}

/**
 * Reconnexion du singleton (idleTimeout Bun, réseau).
 *
 * Pas de GET si on reprend au curseur dans la fenêtre de rejeu. Le GET n'est
 * dû que lorsqu'un flux déjà ouvert a dépassé le snapshot de cet écran
 * (événements consommés avant l'abonnement). Un `stream.gap` est traité à part.
 */
export function refetchOnStreamOpen(mayHaveMissed: boolean): { thread: boolean; roster: boolean } {
  return mayHaveMissed ? { thread: true, roster: true } : { thread: false, roster: false };
}

/**
 * GET après le patch.
 *
 * Un delta d'un run déjà présent se patche en place. On ne relit que si le
 * run est encore absent après application.
 *
 * Trou : `ProductEventType` n'a pas de `run.created`. La charge d'un delta
 * ne porte pas de `RunDto` (`input`, `createdAt`, `hermesResponseId`).
 * `applyProductEventToSnapshot` n'insère donc pas de ligne. On n'invente
 * pas ces champs : un run absent le reste, et on relit.
 *
 * Le reçu `message.admitted` d'un message que le snapshot a déjà (le 202 de
 * CET onglet l'a posé, avec son run) n'apprend rien : il arrive avec le
 * premier événement du run, et sa relecture coûtait un `GET /history` en
 * plein stream. Un message inconnu (autre onglet, autre appareil)
 * reste relu.
 */
export function refreshAfterAppliedEvent(input: {
  event: StoredProductEvent;
  hadSnapshot: boolean;
  snapshotAfter: { runs: readonly { id: string }[]; messages?: readonly { id: string }[] } | undefined;
  snapshotCursorBefore: number | undefined;
}): { thread: boolean; roster: boolean } {
  const unknownRun = input.hadSnapshot
    && input.snapshotAfter !== undefined
    && !input.snapshotAfter.runs.some((run) => run.id === input.event.runId);
  if (!unknownRun && isKnownAdmission(input.event, input.snapshotAfter?.messages)) {
    return { thread: false, roster: false };
  }
  return snapshotRefreshAfterEvent({
    event: input.event,
    hasSnapshot: input.hadSnapshot,
    unknownRun,
    snapshotCursor: input.snapshotCursorBefore,
  });
}

function isKnownAdmission(event: StoredProductEvent, messages: readonly { id: string }[] | undefined): boolean {
  if (event.type !== "message.admitted" || !messages) return false;
  const messageId = event.payload.messageId;
  return typeof messageId === "string" && messages.some((message) => message.id === messageId);
}
