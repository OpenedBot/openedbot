import { isUuid } from "@openedbot/contracts-primitives";
import type { TransactionSQL } from "bun";
import type { HermesHostProfile, HermesProfileAvatar } from "@openedbot/hermes";
import { insertImportedAvatarAttachment } from "@openedbot/conversation/sql/attachments";
import { insertBotDefaultThread, insertGroupThread } from "@openedbot/conversation/sql/threads";
import { insertDisabledRoutine } from "@openedbot/execution/sql/routines";
import {
  insertGroupMember,
  insertImportedBot,
  insertImportedBotGroup,
} from "@openedbot/roster/sql/bot-import";
import { defaultPermissionMode } from "@openedbot/roster/sql/bots";
import { classifyHermesSchedule, mapHermesFace, scheduleLimitation } from "../domain/runtime-profile-import";
import { GROUP_MEMBERS_MAX, GROUP_MEMBERS_MIN, type RuntimeProfileImportDto } from "@openedbot/contracts-api";

export type ImportBlobStore = {
  driver: "file" | "r2";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
};
export type ImportContext = {
  organizationId: string; userId: string; sectionId: string;
  position: number; managed: boolean; model: string | null;
  botId?: string; threadId?: string;
  avatarId?: string;
  /** Already uploaded by the durable executor, before the roster transaction. */
  avatarStored?: boolean;
  blobKeys?: string[];
};

export function importObjectKey(organizationId: string, id: string): string {
  if (!isUuid(organizationId) || !isUuid(id)) throw new Error("Invalid blob identity");
  return `org/${organizationId}/${id}`;
}

export async function importHermesProfile(
  tx: TransactionSQL, ctx: ImportContext, profile: HermesHostProfile,
  avatar: HermesProfileAvatar | null, blobs?: ImportBlobStore,
): Promise<{ botId: string; threadId: string; name: string; routines: RuntimeProfileImportDto["routines"]; limitations: string[]; groups: string[] }> {
  const slug = profile.name;
  const botId = ctx.botId ?? crypto.randomUUID();
  const threadId = ctx.threadId ?? crypto.randomUUID();
  const name = profile.displayName || profile.title || slug;
  const limitations: string[] = [];
  let artwork: string | undefined;
  if (avatar && blobs) {
    const id = ctx.avatarId ?? crypto.randomUUID();
    const key = importObjectKey(ctx.organizationId, id);
    let stored = ctx.avatarStored === true;
    if (!stored) {
      // Track before upload: even a failed upload may have written the object.
      ctx.blobKeys?.push(key);
      try { await blobs.put(key, avatar.bytes, avatar.contentType); stored = true; }
      catch { limitations.push(`avatar-not-imported:${slug}`); }
    }
    if (stored) {
      // A SQL error must abort the transaction, never become a cosmetic warning.
      await insertImportedAvatarAttachment(tx, {
        id,
        organizationId: ctx.organizationId,
        objectKey: key,
        driver: blobs.driver,
        name: `${slug}-avatar`,
        contentType: avatar.contentType,
        bytes: avatar.bytes.byteLength,
      });
      artwork = `/api/attachments/${id}`;
    }
  } else if (profile.hasAvatar) limitations.push(`avatar-not-imported:${slug}`);
  const face = mapHermesFace({ color: profile.uiMeta?.color, shape: profile.uiMeta?.shape, seed: slug, artwork });
  await insertImportedBot(tx, {
    botId,
    organizationId: ctx.organizationId,
    sectionId: ctx.sectionId,
    name,
    slug,
    description: profile.description,
    instructions: profile.soul?.trim() ?? "",
    model: ctx.model,
    managed: ctx.managed,
    position: ctx.position,
    pinned: profile.uiMeta?.pinned === true,
    face,
    permissionMode: await defaultPermissionMode(tx, ctx.organizationId),
  });
  await insertBotDefaultThread(tx, { threadId, organizationId: ctx.organizationId, botId, title: name });
  const routines: RuntimeProfileImportDto["routines"] = [];
  for (const routine of profile.routines) {
    const classified = classifyHermesSchedule(routine.schedule);
    if (!classified.cron) {
      const limitation = scheduleLimitation(classified.kind, slug, routine.schedule);
      if (limitation) limitations.push(limitation);
      continue;
    }
    if (classified.kind === "every") limitations.push(`routine-schedule-every-anchored:${slug}:${routine.schedule}`);
    const routineId = crypto.randomUUID();
    await insertDisabledRoutine(tx, {
      id: routineId,
      organizationId: ctx.organizationId,
      botId,
      userId: ctx.userId,
      name: routine.name,
      schedule: classified.cron,
      message: routine.prompt,
    });
    routines.push({ slug, routineId, name: routine.name, schedule: classified.cron });
    limitations.push(`routine-timezone-defaulted-to-utc:${slug}:${routine.name}`);
    if (routine.enabled) limitations.push(`routine-enabled-state-not-preserved:${slug}:${routine.name}`);
  }
  return { botId, threadId, name, routines, limitations, groups: profile.uiMeta?.groups ?? [] };
}

export async function createImportedGroups(
  tx: TransactionSQL,
  ctx: { organizationId: string; sectionId: string; position: number },
  members: Map<string, Array<{ botId: string; slug: string }>>,
): Promise<{ groups: RuntimeProfileImportDto["groups"]; limitations: string[] }> {
  const groups: RuntimeProfileImportDto["groups"] = [];
  const limitations: string[] = [];
  let position = ctx.position;
  for (const [name, candidates] of members) {
    const unique = [...new Map(candidates.map((member) => [member.botId, member])).values()];
    if (unique.length < GROUP_MEMBERS_MIN || unique.length > GROUP_MEMBERS_MAX) {
      limitations.push(`group-size-out-of-bounds:${name}:${unique.length}`);
      continue;
    }
    const groupId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    await insertImportedBotGroup(tx, {
      groupId,
      organizationId: ctx.organizationId,
      sectionId: ctx.sectionId,
      name,
      position: position++,
    });
    await insertGroupThread(tx, { threadId, organizationId: ctx.organizationId, groupId, title: name });
    for (const [index, member] of unique.entries()) {
      await insertGroupMember(tx, { organizationId: ctx.organizationId, groupId, botId: member.botId, position: index });
    }
    groups.push({ name, groupId, memberSlugs: unique.map((member) => member.slug) });
  }
  return { groups, limitations };
}
