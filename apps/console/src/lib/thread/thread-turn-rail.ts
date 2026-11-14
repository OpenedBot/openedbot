import type { ThreadMessageDto } from "@openedbot/contracts-api";
import { replyPreviewSnippet } from "@openedbot/conversation/domain/message-reply";

/**
 * Turn navigation rail (desktop): one tick per operator
 * message, the question + answer preview on hover, the click brings the turn back.
 *
 * A `user` with `authorBot` is another bot (hand-off, room): it is not
 * an operator turn, it takes no tick. The displayed answer
 * is the first following `assistant`; in a room, that is often the
 * first contribution, not the team card's synthesis.
 *
 * The rail passes no prop to the thread (`ThreadTimeline` is `memo`, cache per
 * turn): it reads the DOM through `data-thread-find-target`, and asks the thread to
 * mount a turn outside the mounted rows through `requestThreadReveal` (`thread-reveal.ts`).
 */

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

/**
 * The ticks to light: a turn's section runs from its top to the next turn's
 * top, lit when it crosses the view. `null` is a turn without a node, out of
 * the mounted rows: above them when a later turn is mounted, below otherwise.
 */
export function litRailTurns(tops: ReadonlyArray<number | null>, view: { top: number; bottom: number }): Set<number> {
  const placed = [...tops];
  let mountedAfter = false;
  for (let index = placed.length - 1; index >= 0; index -= 1) {
    if (placed[index] !== null) mountedAfter = true;
    else placed[index] = mountedAfter ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  const lit = new Set<number>();
  placed.forEach((top, index) => {
    const bottom = placed[index + 1] ?? Number.POSITIVE_INFINITY;
    if (top! < view.bottom && bottom! > view.top) lit.add(index);
  });
  return lit;
}

/**
 * At most one rail measurement per interval. It reads each
 * turn's position (`getBoundingClientRect`, one query per turn) on every scroll;
 * yet the thread pinned at the bottom scrolls every frame while an answer
 * is being written, and those layout reads cost more than the answer
 * itself (profile D1c). The last request is never lost: it leaves
 * at the end of the interval.
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

/** `run` on the next frame, at most once per `intervalMs`. */
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
