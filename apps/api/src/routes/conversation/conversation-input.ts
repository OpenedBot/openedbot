import { isStrictUuid } from "@openedbot/contracts-primitives";
import {
  rejectAttachments,
  type MessageAttachmentInput,
} from "@openedbot/conversation/domain/attachments";
import { planRoutineGroupSend, type GroupFollowUp, type GroupSendState } from "@openedbot/execution/domain/group-send";
import {
  isMessageReactionEmoji,
  type MessageReactionEmoji,
} from "@openedbot/conversation/domain/message-reply";
import type { BotFaceSpec, GroupDefaultResponder } from "@openedbot/contracts-api";
import { assertString, HttpError } from "../../interfaces/http/http-error";

/**
 * Un client ne peut accuser que le watermark ISO qu'il a réellement observé.
 * Les dates futures sont refusées : sinon une horloge ou un appel malveillant
 * pourrait masquer des réponses qui n'existent pas encore.
 */
export function parseReadThrough(value: unknown, now = Date.now()): Date {
  const raw = assertString(value, "Le watermark de lecture", { max: 64 });
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== raw || parsed.getTime() > now + 60_000) {
    throw new HttpError(400, "THREAD_READ_INVALID", "Le watermark de lecture est invalide.");
  }
  return parsed;
}

/**
 * Ouvre l'envoi d'un salon : l'orateur du premier tour, sa position dans le
 * roster et l'état (`runs.group_state`) que son run portera. 409 si le groupe
 * n'a plus aucun membre actif : un salon vide ne peut pas répondre.
 */
export function openGroupSend(
  input: string,
  members: ReadonlyArray<{ id: string; slug: string; position: number }>,
  defaultResponder: GroupDefaultResponder = { kind: "everyone" },
  followUp?: GroupFollowUp,
  replyToBotId?: string | null,
  teamMode = false,
): { botId: string; position: number; state: GroupSendState } {
  const planned = planRoutineGroupSend(input, members, defaultResponder, followUp, replyToBotId, teamMode);
  if (planned.kind === "empty") {
    throw new HttpError(409, "GROUP_EMPTY", "Ce groupe n'a plus de membre actif.");
  }
  return { botId: planned.botId, position: planned.position, state: planned.state };
}

/** `planOnly`: absent or `false` is an ordinary turn; anything but a boolean is refused. */
export function readPlanOnly(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  throw new HttpError(400, "PLAN_ONLY_INVALID", "planOnly doit être un booléen.");
}

export function readReplyToId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isStrictUuid(value.trim())) {
    throw new HttpError(400, "REPLY_TARGET_INVALID", "Le message cité est invalide.");
  }
  return value.trim().toLowerCase();
}

export function readMessageReaction(value: unknown): MessageReactionEmoji {
  if (!isMessageReactionEmoji(value)) {
    throw new HttpError(400, "REACTION_INVALID", "Cette réaction n’est pas autorisée.");
  }
  return value as MessageReactionEmoji;
}

/**
 * `ThreadGroupInfo` du snapshot : de quoi nommer le salon et dessiner ses
 * membres actifs (les archivés n'y parlent plus ; un auteur archivé reste
 * attribué via `authorBot`). `null` sur un fil DM.
 */
export async function readThreadGroup(tx: Bun.TransactionSQL, organizationId: string, groupId: string | null) {
  if (!groupId) return null;
  const groups = await tx<Array<{ id: string; name: string; needsYou: boolean }>>`
    select id, name, needs_you as "needsYou" from bot_groups
     where organization_id = ${organizationId} and id = ${groupId}
  `;
  const group = groups[0];
  if (!group) return null;
  const members = await tx<Array<{
    id: string; name: string; slug: string; face: BotFaceSpec | null; voiceId: string | null;
  }>>`
    select b.id, b.name, b.slug, b.face, b.voice_id as "voiceId" from group_members gm
      join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
     where gm.organization_id = ${organizationId} and gm.group_id = ${groupId} and b.archived_at is null
     order by gm.position asc
  `;
  return { ...group, members };
}

export function readAttachments(value: unknown): MessageAttachmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "ATTACHMENTS_INVALID", "Les pièces jointes sont invalides.");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "ATTACHMENTS_INVALID", "Pièce jointe invalide.");
    const input = item as Partial<MessageAttachmentInput>;
    if (
      typeof input.name !== "string" || typeof input.contentType !== "string" ||
      (input.kind !== "image" && input.kind !== "document") || !Array.isArray(input.content)
    ) throw new HttpError(400, "ATTACHMENTS_INVALID", "Pièce jointe invalide.");
    return input as MessageAttachmentInput;
  });
}

export function attachmentError(rejection: ReturnType<typeof rejectAttachments> & {}): string {
  if (!rejection) return "Pièce jointe invalide.";
  if (rejection.code === "ATTACHMENTS_TOO_MANY") return `Cinq fichiers maximum sont autorisés.`;
  if (rejection.code === "ATTACHMENT_TOO_LARGE") return `${rejection.name} dépasse 1 Mo.`;
  if (rejection.code === "ATTACHMENTS_TOO_LARGE") return "Les fichiers dépassent 3 Mo pour ce message.";
  return `${rejection.name} est vide.`;
}

export function dateFields(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  for (const key of [
    "createdAt", "updatedAt", "startedAt", "endedAt", "lastEventAt", "occurredAt", "expiresAt", "deadlineAt",
  ]) {
    const value = result[key];
    if (value instanceof Date) result[key] = value.toISOString();
  }
  return result;
}
