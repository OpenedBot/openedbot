import { isoInstant } from "@openedbot/contracts-primitives";
import type { GroupDefaultResponder, GroupDto } from "@openedbot/contracts-api";
import { GROUP_MEMBERS_MAX, GROUP_MEMBERS_MIN } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { assertString } from "@openedbot/platform-config/http-body";
import { readSectionId } from "./section-id";

export type GroupRow = {
  id: string; name: string; instructions: string; defaultResponder: unknown; answerMode?: unknown; threadId: string; sectionId: string; position: number; pinned?: boolean; needsYou: boolean;
  awaitingApproval: boolean; unread?: boolean; hidden?: boolean; running: boolean; preview: string | null; lastActivityAt: Date | string;
  createdAt: Date | string; updatedAt: Date | string;
};
export type MemberRow = {
  groupId: string; id: string; name: string; slug: string; face: GroupDto["members"][number]["face"];
  voiceId: string | null; archivedAt: Date | string | null; position: number;
};

/** Les lignes `bot_groups` et leurs membres, rendues comme les `GroupDto` de l'API. */
export function groupDtos(rows: readonly GroupRow[], members: readonly MemberRow[]): GroupDto[] {
  return rows.map((row) => {
    const groupMembers = members.filter((member) => member.groupId === row.id).map(({ groupId: _, position: __, ...member }) => ({
      ...member, archivedAt: member.archivedAt ? isoInstant(member.archivedAt) : null,
    }));
    return {
      ...row,
      defaultResponder: readGroupDefaultResponder(row.defaultResponder, groupMembers.map((member) => member.id)),
      answerMode: row.answerMode === "team" ? "team" : "each",
      pinned: Boolean(row.pinned),
      unread: Boolean(row.unread),
      hidden: Boolean(row.hidden),
      members: groupMembers,
      lastActivityAt: isoInstant(row.lastActivityAt), createdAt: isoInstant(row.createdAt), updatedAt: isoInstant(row.updatedAt),
    };
  });
}

export function readMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "GROUP_MEMBERS_INVALID", "Les membres du groupe sont invalides.");
  const ids = [...new Set(value.filter((item): item is string => typeof item === "string"))];
  if (ids.length < GROUP_MEMBERS_MIN || ids.length > GROUP_MEMBERS_MAX || ids.length !== value.length) {
    throw new HttpError(400, "GROUP_MEMBERS_INVALID", "Un groupe contient entre deux et six bots distincts.");
  }
  return ids;
}
export function readGroupInstructions(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new HttpError(400, "GROUP_INSTRUCTIONS_INVALID", "Les instructions du salon sont invalides.");
  const instructions = value.trim();
  if (instructions.length > 12_000) throw new HttpError(400, "GROUP_INSTRUCTIONS_TOO_LONG", "Les instructions du salon dépassent 12 000 caractères.");
  return instructions;
}

/** Parse strictement la règle et interdit qu'un pilote sorte du roster du salon. */
export function readGroupDefaultResponder(
  value: unknown,
  memberIds: readonly string[],
  fallback?: GroupDefaultResponder,
): GroupDefaultResponder {
  if (value === undefined) {
    if (fallback) return fallback;
    throw new HttpError(500, "GROUP_RESPONDER_CORRUPT", "La règle de réponse du salon est invalide.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "GROUP_RESPONDER_INVALID", "La règle de réponse du salon est invalide.");
  }
  const responder = value as Record<string, unknown>;
  const keys = Object.keys(responder);
  if ((responder.kind === "everyone" || responder.kind === "mentions") && keys.length === 1) {
    return { kind: responder.kind };
  }
  if (
    responder.kind === "member" &&
    keys.length === 2 &&
    typeof responder.botId === "string" &&
    memberIds.includes(responder.botId)
  ) {
    return { kind: "member", botId: responder.botId };
  }
  throw new HttpError(
    400,
    responder.kind === "member" ? "GROUP_RESPONDER_NOT_MEMBER" : "GROUP_RESPONDER_INVALID",
    responder.kind === "member"
      ? "Le bot pilote doit rester membre du salon."
      : "La règle de réponse du salon est invalide.",
  );
}

/** `answerMode` d'une requête : absent laisse la colonne, inconnu est refusé. */
export function readGroupAnswerMode(value: unknown): "each" | "team" | null {
  if (value === undefined || value === null) return null;
  if (value === "each" || value === "team") return value;
  throw new HttpError(400, "GROUP_ANSWER_MODE_INVALID", "Le mode de réponse du salon est invalide.");
}

/** Un `POST /api/groups` lu et validé. */
export type CreateGroupInput = {
  name: string;
  instructions: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  answerMode: "each" | "team";
  sectionId: string | null;
};

export function readCreateGroupInput(body: Record<string, unknown>): CreateGroupInput {
  const name = assertString(body.name, "Le nom du groupe", { max: 100 });
  const instructions = readGroupInstructions(body.instructions) ?? "";
  const memberIds = readMemberIds(body.memberIds);
  const defaultResponder = readGroupDefaultResponder(body.defaultResponder, memberIds, { kind: "everyone" });
  const answerMode = readGroupAnswerMode(body.answerMode) ?? "each";
  return {
    name,
    instructions,
    memberIds,
    defaultResponder,
    answerMode,
    sectionId: typeof body.sectionId === "string" ? body.sectionId : null,
  };
}

/**
 * Un `PATCH /api/groups/:groupId` lu et validé. `null` veut dire « ne pas
 * toucher », `undefined` pour `memberIds` et `defaultResponder` « absent » :
 * la règle de réponse se valide contre les membres COURANTS quand le corps n'en
 * donne pas, donc dans le cas d'usage, qui lit la base.
 */
export type GroupPatchInput = {
  name: string | null;
  instructions: string | null;
  memberIds: string[] | undefined;
  defaultResponder: unknown;
  answerMode: "each" | "team" | null;
  sectionId: string | null;
  pinned: boolean | null;
};

export function readGroupPatch(body: Record<string, unknown>): GroupPatchInput {
  // Même garde que le bot (`readSectionId`) : une chaîne brute partait
  // telle quelle dans la colonne `uuid` : 22P02 ou 23503, donc « Erreur
  // interne » pour un simple dépôt de salon sur une section.
  const sectionId = Object.hasOwn(body, "sectionId") ? readSectionId(body.sectionId) : null;
  return {
    name: typeof body.name === "string" ? body.name.trim().slice(0, 100) : null,
    instructions: readGroupInstructions(body.instructions),
    memberIds: body.memberIds === undefined ? undefined : readMemberIds(body.memberIds),
    defaultResponder: body.defaultResponder,
    answerMode: readGroupAnswerMode(body.answerMode),
    sectionId,
    pinned: typeof body.pinned === "boolean" ? body.pinned : null,
  };
}
