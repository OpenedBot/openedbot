import { HermesClientError } from "@openedbot/hermes";

type StreamFlushTimer = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

const streamFlushTimer: StreamFlushTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

type HermesStreamWake<T> =
  | { kind: "event"; result: IteratorResult<T> }
  | { kind: "flush" };

/**
 * Attend le prochain événement SANS laisser un delta déjà reçu prisonnier de
 * l'itérateur. Le même `next` est réutilisable après un réveil `flush` : on ne
 * lance donc jamais deux lectures concurrentes sur le corps SSE.
 */
export function waitForHermesEventOrFlush<T>(
  next: Promise<IteratorResult<T>>,
  flushInMs: number | null,
  timer: StreamFlushTimer = streamFlushTimer,
): Promise<HermesStreamWake<T>> {
  if (flushInMs === null) return next.then((result) => ({ kind: "event", result }));
  return new Promise<HermesStreamWake<T>>((resolve, reject) => {
    let settled = false;
    const handle = timer.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "flush" });
    }, Math.max(0, flushInMs));
    next.then(
      (result) => {
        if (settled) return;
        settled = true;
        timer.clearTimeout(handle);
        resolve({ kind: "event", result });
      },
      (error) => {
        if (settled) return;
        settled = true;
        timer.clearTimeout(handle);
        reject(error);
      },
    );
  });
}

function shouldSkipHermesSequence(rawSequence: number, lastPersistedSequence: number): boolean {
  return rawSequence <= lastPersistedSequence;
}

type HermesFrameDisposition = {
  action: "gap" | "skip" | "emit";
  rawSequence: number;
};

/**
 * Ce que le pump fait d'une trame Hermes avant de la normaliser.
 *
 * Le journal du connecteur numérote chaque trame sans saut. Une séquence
 * absente ou différente de la suivante attendue est un trou : le polling
 * tranche sans avancer le curseur. Sans rejeu, une séquence déjà persistée
 * est sautée.
 */
export function classifyHermesFrame(
  frame: { sequence?: number },
  state: { replaySupported: boolean; rawSequence: number; lastPersistedSequence: number },
): HermesFrameDisposition {
  if (state.replaySupported && frame.sequence !== state.rawSequence + 1) {
    return { action: "gap", rawSequence: state.rawSequence };
  }
  const rawSequence = frame.sequence ?? state.rawSequence + 1;
  return {
    action: shouldSkipHermesSequence(rawSequence, state.lastPersistedSequence) ? "skip" : "emit",
    rawSequence,
  };
}

/** Reprises du flux SSE par `?since=` avant de basculer en polling. */
export const MAX_EVENT_REPLAY_ATTEMPTS = 3;

/** 1 s, 2,5 s, 5 s : le temps que l'hôte rouvre son lien (backoff 1 s × 2ⁿ côté connecteur). */
export function eventReplayDelayMs(attempt: number): number {
  if (attempt <= 1) return 1_000;
  if (attempt === 2) return 2_500;
  return 5_000;
}

/**
 * Ce qu'un rejeu peut rattraper : un flux rompu après réponse, ou un lien
 * fermé avant que la requête ne parte (l'hôte se reconnecte). Une réponse
 * invalide ou une limite de protocole ne se rejouent pas.
 */
export function isReplayableStreamFailure(error: unknown): error is HermesClientError {
  if (!(error instanceof HermesClientError)) return false;
  if (error.code === "HERMES_STREAM_INTERRUPTED") return true;
  return error.code === "HERMES_UNREACHABLE" && error.requestDelivery === "not_sent";
}
