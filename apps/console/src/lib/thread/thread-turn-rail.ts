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
