import type { SQL } from "bun";
import type { CleanupOwner } from "./cleanup-workflows";

export type CleanupGroup = { id: string | null; organizationId: string | null; members: CleanupOwner[] };
export async function readCleanupGroups(db: SQL, botId: string): Promise<CleanupGroup[]> {
  return db<CleanupGroup[]>`
    select membership.group_id as id, g.organization_id as "organizationId",
      jsonb_agg(jsonb_build_object('botId', member.bot_id, 'organizationId', b.organization_id)) as members
      from group_members membership
      left join bot_groups g on g.id = membership.group_id and g.organization_id = membership.organization_id
      left join group_members member on member.group_id = membership.group_id
      left join bots b on b.id = member.bot_id and b.organization_id = member.organization_id
     where membership.bot_id = ${botId}
     group by membership.group_id, g.organization_id`;
}

function ownedGroups(groups: CleanupGroup[], botId: string, organizationId: string, live: ReadonlySet<string>): void {
  if (!live.has(botId) || !groups.length || new Set(groups.map((group) => group.id)).size !== groups.length || groups.some((group) =>
    !group.id || group.organizationId !== organizationId || !group.members.length
    || !group.members.some((member) => member.botId === botId)
    || group.members.some((member) => !member.botId || member.organizationId !== organizationId || !live.has(member.botId)))) {
    throw new Error("Forced purge refused: every related group and member must have proven ownership in this live BotLab and organization.");
  }
}

/** Force may detach groups or delete a group below its minimum membership. */
export async function forceOnlyOwnedGroupRefusal(
  response: Response, botId: string, organizationId: string, live: ReadonlySet<string>,
  loadGroups: () => Promise<CleanupGroup[]>, settle: () => Promise<void>, force: () => Promise<Response>,
): Promise<Response> {
  if (response.status !== 409) return response;
  let body: unknown;
  try { body = await response.clone().json(); } catch { return response; }
  if (!body || typeof body !== "object" || !("error" in body)) return response;
  const error = body.error;
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "BOT_IN_GROUP") return response;
  ownedGroups(await loadGroups(), botId, organizationId, live);
  await settle();
  // Settlement may wait; re-read every membership at the consequential step.
  ownedGroups(await loadGroups(), botId, organizationId, live);
  return force();
}
