import { isoInstant } from "@openedbot/contracts-primitives";
import type { BotFaceSpec, MessageContent, ThreadMessageDto } from "@openedbot/contracts-api";

/**
 * `relaying` n'existe pas côté client (`ProductRunStatus` de
 * `contracts/api`, intouchable) : il est rendu comme `running`, car un courrier est bien un run
 * actif, non terminal, qui n'attend rien de l'opérateur.
 */
export const publicRunStatus = (status: unknown): unknown =>
  status === "relaying" ? "running" : status === "unknown" ? "failed" : status;

export type MessageRow = {
  sequence?: string;
  clientSubmissionId?: string | null;
  id: string; role: string; content: unknown; runId: string | null; authorBotId: string | null;
  authorBotName: string | null; authorBotSlug: string | null; authorBotFace: BotFaceSpec | null;
  replyToId?: string | null; replyToRole?: string | null; replyToContent?: unknown;
  replyAuthorBotId?: string | null; replyAuthorBotName?: string | null;
  replyAuthorBotSlug?: string | null; replyAuthorBotFace?: BotFaceSpec | null;
  reactions?: unknown;
  createdAt: Date | string;
};

/**
 * `ThreadMessageDto` : l'attribution `authorBot` est relue au moment de la
 * lecture : `name`/`slug`/`face` nuls si le bot auteur a été supprimé depuis.
 */
export function messageDto(row: MessageRow): ThreadMessageDto & { authorBotId: string | null } {
  const {
    authorBotName, authorBotSlug, authorBotFace, createdAt, role, content,
    replyToId, replyToRole, replyToContent,
    replyAuthorBotId, replyAuthorBotName, replyAuthorBotSlug, replyAuthorBotFace,
    reactions,
    ...message
  } = row;
  return {
    ...message,
    role: role === "assistant" ? "assistant" : "user",
    content: Array.isArray(content) ? content as MessageContent : [],
    createdAt: isoInstant(createdAt),
    authorBot: message.authorBotId
      ? { id: message.authorBotId, name: authorBotName, slug: authorBotSlug, face: authorBotFace }
      : null,
    ...(replyToId !== undefined ? {
      replyTo: replyToId && (replyToRole === "user" || replyToRole === "assistant") && Array.isArray(replyToContent)
        ? {
            id: replyToId,
            role: replyToRole,
            content: replyToContent as MessageContent,
            authorBot: replyAuthorBotId
              ? {
                  id: replyAuthorBotId,
                  name: replyAuthorBotName ?? null,
                  slug: replyAuthorBotSlug ?? null,
                  face: replyAuthorBotFace ?? null,
                }
              : null,
          }
        : null,
    } : {}),
    ...(reactions !== undefined ? { reactions: readReactionRows(reactions) } : {}),
  };
}

function readReactionRows(value: unknown): ThreadMessageDto["reactions"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.emoji !== "string" || typeof row.reactedByMe !== "boolean") return [];
    const count = Number(row.count);
    return Number.isSafeInteger(count) && count > 0
      ? [{ emoji: row.emoji, count, reactedByMe: row.reactedByMe }]
      : [];
  });
}
