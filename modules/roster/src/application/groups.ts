import type { GroupDto } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import {
  readGroupDefaultResponder,
  type CreateGroupInput,
  type GroupPatchInput,
} from "../domain/groups";
import {
  deleteGroupRow,
  hasPendingGroupIngress,
  insertGroup,
  lockActiveGroupRuns,
  lockActiveMemberBots,
  lockGroup,
  lockGroupWithResponder,
  nextGroupPosition,
  nextGroupPositionExcluding,
  readActiveGroupRuns,
  readGroupMemberIds,
  readGroups,
  replaceGroupMembers,
  updateGroupRow,
} from "../sql/groups";
import { readDefaultSectionId, sectionExists } from "../sql/sections";
import { pruneEmptySections } from "../sql/section-prune";

export async function listGroups(db: Db, organizationId: string, userId: string): Promise<GroupDto[]> {
  return withTenant(db, organizationId, (tx) => readGroups(tx, organizationId, undefined, userId));
}

export async function readGroup(
  db: Db,
  organizationId: string,
  userId: string,
  groupId: string,
): Promise<GroupDto> {
  const groups = await withTenant(db, organizationId, (tx) => readGroups(tx, organizationId, groupId, userId));
  if (!groups[0]) throw new HttpError(404, "GROUP_NOT_FOUND", "Groupe introuvable.");
  return groups[0];
}

export async function createGroup(
  db: Db,
  organizationId: string,
  userId: string,
  input: CreateGroupInput,
): Promise<GroupDto> {
  const id = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  await withTenant(db, organizationId, async (tx) => {
    const active = await lockActiveMemberBots(tx, organizationId, input.memberIds);
    if (active.length !== input.memberIds.length) {
      throw new HttpError(400, "GROUP_MEMBER_INVALID", "Un membre du groupe est invalide.");
    }
    const sectionId = input.sectionId || await readDefaultSectionId(tx, organizationId);
    if (!sectionId) throw new HttpError(409, "SECTION_REQUIRED", "Créez une section avant le groupe.");
    await insertGroup(tx, {
      id,
      threadId,
      organizationId,
      sectionId,
      name: input.name,
      instructions: input.instructions,
      defaultResponder: input.defaultResponder,
      answerMode: input.answerMode,
      position: await nextGroupPosition(tx, organizationId, sectionId),
      memberIds: input.memberIds,
    });
  });
  const created = await withTenant(db, organizationId, (tx) => readGroups(tx, organizationId, id, userId));
  return created[0]!;
}

export async function updateGroup(
  db: Db,
  organizationId: string,
  userId: string,
  groupId: string,
  patch: GroupPatchInput,
): Promise<GroupDto> {
  await withTenant(db, organizationId, async (tx) => {
    const active = patch.memberIds === undefined ? [] : await lockActiveGroupRuns(tx, organizationId, groupId);
    const group = await lockGroupWithResponder(tx, organizationId, groupId);
    if (!group) throw new HttpError(404, "GROUP_NOT_FOUND", "Groupe introuvable.");
    if (patch.memberIds !== undefined) {
      if (active[0] || (await readActiveGroupRuns(tx, organizationId, groupId))[0]) {
        throw new HttpError(
          409,
          "GROUP_BUSY",
          "Les membres ne peuvent pas changer pendant une mission ou une réconciliation.",
        );
      }
    }
    const memberIds = patch.memberIds === undefined
      ? await readGroupMemberIds(tx, organizationId, groupId)
      : patch.memberIds;
    if (patch.memberIds !== undefined) {
      // Même garde que la création : au réveil d'un verrou concurrent, la
      // clause archived_at est réévaluée avant toute mutation du roster.
      const bots = await lockActiveMemberBots(tx, organizationId, memberIds);
      if (bots.length !== memberIds.length) throw new HttpError(400, "GROUP_MEMBER_INVALID", "Un membre du groupe est invalide.");
    }
    const defaultResponder = patch.defaultResponder === undefined
      ? readGroupDefaultResponder(group.defaultResponder, memberIds)
      : readGroupDefaultResponder(patch.defaultResponder, memberIds);
    let nextPosition: number | null = null;
    if (patch.sectionId) {
      if (!(await sectionExists(tx, organizationId, patch.sectionId))) {
        throw new HttpError(404, "SECTION_NOT_FOUND", "Section introuvable.");
      }
      nextPosition = await nextGroupPositionExcluding(tx, organizationId, patch.sectionId, groupId);
    }
    const updated = await updateGroupRow(tx, organizationId, groupId, {
      name: patch.name,
      instructions: patch.instructions,
      defaultResponder,
      answerMode: patch.answerMode,
      sectionId: patch.sectionId,
      position: nextPosition,
      pinned: patch.pinned,
    });
    if (!updated) throw new HttpError(404, "GROUP_NOT_FOUND", "Groupe introuvable.");
    if (patch.sectionId) await pruneEmptySections(tx, organizationId);
    if (patch.memberIds !== undefined) await replaceGroupMembers(tx, organizationId, groupId, memberIds);
  });
  const groups = await withTenant(db, organizationId, (tx) => readGroups(tx, organizationId, groupId, userId));
  return groups[0]!;
}

export async function deleteGroup(db: Db, organizationId: string, groupId: string): Promise<void> {
  const deleted = await withTenant(db, organizationId, async (tx) => {
    const active = await lockActiveGroupRuns(tx, organizationId, groupId);
    const group = await lockGroup(tx, organizationId, groupId);
    if (!group) return false;
    if (active[0] || (await readActiveGroupRuns(tx, organizationId, groupId))[0]) {
      throw new HttpError(409, "GROUP_BUSY", "Ce salon exécute encore une mission ou attend une réconciliation.");
    }
    if (await hasPendingGroupIngress(tx, organizationId, group.threadId)) {
      throw new HttpError(409, "GROUP_SUBMISSION_IN_PROGRESS", "Un message idempotent est encore en cours ou en quarantaine.");
    }
    const gone = await deleteGroupRow(tx, organizationId, groupId);
    if (gone) await pruneEmptySections(tx, organizationId);
    return gone;
  });
  if (!deleted) throw new HttpError(404, "GROUP_NOT_FOUND", "Groupe introuvable.");
}
