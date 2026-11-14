import { isRecord, isStrictUuid } from "@openedbot/contracts-primitives";
import {
  rejectAttachments,
  type MessageAttachmentInput,
  type AttachmentContentPart,
} from "@openedbot/conversation/domain/attachments";
import { planRoutineGroupSend, type GroupFollowUp, type GroupSendState } from "@openedbot/execution/domain/group-send";
import { isValidTimeZone } from "@openedbot/execution/domain/routines";
import {
  isMessageReactionEmoji,
  type MessageReactionEmoji,
} from "@openedbot/conversation/domain/message-reply";
import type { BotFaceSpec, GroupDefaultResponder } from "@openedbot/contracts-api";
import { assertString, HttpError } from "../../interfaces/http/http-error";

/**
 * A client can acknowledge only the ISO watermark it has actually observed.
 * Future dates are refused: otherwise a clock or a malicious call
 * could hide replies that do not exist yet.
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
 * Opens a room's send: the speaker of the first turn, its position in the
 * roster and the state (`runs.group_state`) its run will carry. 409 if the group
 * no longer has any active member: an empty room cannot reply.
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

/**
 * The IANA zone the console sends with a message (0187), handed to the run
 * that answers it as the user's zone for `routine_manage`. A zone this server
 * does not know (a newer tz database than ours) reads as absent rather than
 * refusing the message: the bot then asks the user for their zone.
 */
export function readUserTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = value.trim();
  return /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/.test(zone) && isValidTimeZone(zone) ? zone : null;
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
 * The snapshot's `ThreadGroupInfo`: enough to name the room and draw its
 * active members (archived ones no longer speak in it; an archived author stays
 * attributed via `authorBot`). `null` on a DM thread.
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
    if (!isRecord(item)) throw new HttpError(400, "ATTACHMENTS_INVALID", "Pièce jointe invalide.");
    const input = item;
    if (
      typeof input.name !== "string" || typeof input.contentType !== "string" ||
      (input.kind !== "image" && input.kind !== "document") || !Array.isArray(input.content)
    ) throw new HttpError(400, "ATTACHMENTS_INVALID", "Pièce jointe invalide.");
    if (input.kind === "image" && input.content.length !== 1) throw new HttpError(400, "ATTACHMENTS_INVALID", "Une image doit contenir une seule part image.");
    const content: AttachmentContentPart[] = input.content.map((part: unknown) => {
      if (!isRecord(part)) throw new HttpError(400, "ATTACHMENTS_INVALID", "Le contenu de la pièce jointe est invalide.");
      if (input.kind === "document" && part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
      if (input.kind === "image" && part.type === "image" && typeof part.image === "string") {
        const image = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(part.image);
        const payload = image?.[2];
        const declaredType = String(input.contentType).split(";", 1)[0]!.trim().toLowerCase();
        // Validate before hashing/decoding or reserving ingress. atob would
        // otherwise turn a malformed client image into an unexpected 500.
        if (image && image[1]!.toLowerCase() === declaredType && payload !== undefined
          && payload.length % 4 !== 1 && (!payload.includes("=") || payload.length % 4 === 0)) {
          return { type: "image", image: part.image };
        }
      }
      throw new HttpError(400, "ATTACHMENTS_INVALID", "Le contenu de la pièce jointe est invalide.");
    });
    return { name: input.name, contentType: input.contentType, kind: input.kind, content };
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
