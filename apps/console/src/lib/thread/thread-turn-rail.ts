import type { ThreadMessageDto } from "@openedbot/contracts-api";
import { replyPreviewSnippet } from "@openedbot/conversation/domain/message-reply";

/**
 * Rail de navigation par tours (bureau) : un trait par message de
 * l'opérateur, l'aperçu question + réponse au survol, le clic ramène le tour.
 *
 * Un `user` avec `authorBot` est un autre bot (hand-off, salon) : ce n'est
 * pas un tour de l'opérateur, il ne prend pas de trait. La réponse affichée
 * est le premier `assistant` qui suit ; dans un salon, c'est souvent la
 * première contribution, pas la synthèse de la carte d'équipe.
 *
 * Le rail ne passe aucune prop au fil (`ThreadTimeline` est `memo`, cache par
 * tour) : il lit le DOM par `data-thread-find-target`, et demande au fil de
 * monter un tour sorti de la fenêtre par l'événement `THREAD_REVEAL_EVENT`.
 */
export const THREAD_REVEAL_EVENT = "openedbot:thread-reveal";

export type ThreadRevealDetail = { targetId: string };

export type ThreadRailTurn = {
  targetId: string;
  question: string;
  answer: string | null;
};

const textOf = (message: ThreadMessageDto) =>
  message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");

export function buildThreadRailTurns(
  messages: readonly ThreadMessageDto[],
  projectedUserInputs?: readonly { id: string; text: string }[],
): ThreadRailTurn[] {
  const turns: ThreadRailTurn[] = [];
  const projectedUserText = projectedUserInputs
    ? new Map(projectedUserInputs.map((input) => [input.id, input.text]))
    : null;
  for (const message of messages) {
    if (message.role === "user") {
      if (message.authorBot) continue;
      turns.push({
        targetId: `message:${message.id}`,
        question: replyPreviewSnippet(projectedUserText?.get(message.id) ?? textOf(message), 80),
        answer: null,
      });
      continue;
    }
    const current = turns.at(-1);
    if (message.role !== "assistant" || !current || current.answer) continue;
    const text = textOf(message).trim();
    if (text) current.answer = replyPreviewSnippet(text, 180);
  }
  return turns;
}

export function requestThreadReveal(targetId: string) {
  document.dispatchEvent(
    new CustomEvent<ThreadRevealDetail>(THREAD_REVEAL_EVENT, { detail: { targetId } }),
  );
}

/**
 * Au plus une mesure du rail par intervalle. Il lit la position de chaque
 * tour (`getBoundingClientRect`, une requête par tour) à chaque défilement ;
 * or le fil épinglé en bas défile à chaque frame pendant qu'une réponse
 * s'écrit, et ces lectures de mise en page coûtaient plus que la réponse
 * elle-même (profil D1c). La dernière demande n'est jamais perdue : elle part
 * à la fin de l'intervalle.
 */
export const RAIL_MEASURE_INTERVAL_MS = 100;

export type FrameIo = {
  now: () => number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (id: ReturnType<typeof setTimeout>) => void;
};

const browserFrameIo: FrameIo = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (id) => clearTimeout(id),
};

/** `run` à la prochaine frame, au plus une fois par `intervalMs`. */
export function throttledFrame(run: () => void, intervalMs: number, io: FrameIo = browserFrameIo) {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = Number.NEGATIVE_INFINITY;
  const fire = () => {
    frame = null;
    last = io.now();
    run();
  };
  return {
    schedule() {
      if (frame !== null || timer !== null) return;
      const wait = last + intervalMs - io.now();
      if (wait <= 0) {
        frame = io.requestFrame(fire);
        return;
      }
      timer = io.setTimer(() => {
        timer = null;
        frame = io.requestFrame(fire);
      }, wait);
    },
    cancel() {
      if (frame !== null) io.cancelFrame(frame);
      if (timer !== null) io.clearTimer(timer);
      frame = null;
      timer = null;
    },
  };
}
