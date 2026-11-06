import type { GroupDto } from "@openedbot/contracts-api";
import { insertGroupThread } from "@openedbot/conversation/application/threads";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { groupDtos, type GroupRow, type MemberRow } from "../domain/groups";
import { nextSectionRowPosition } from "./sections";

export async function readGroups(
  tx: TransactionDb,
  organizationId: string,
  groupId?: string,
  userId?: string,
  includeHidden = true,
): Promise<GroupDto[]> {
  const rows = await tx<GroupRow[]>`
    select g.id, g.name, g.instructions, g.default_responder as "defaultResponder", g.answer_mode as "answerMode",
           t.id as "threadId", g.section_id as "sectionId", g.position, g.pinned, g.pin_position as "pinPosition",
           g.needs_you as "needsYou",
           exists(select 1 from approval_requests a where a.organization_id = g.organization_id and a.thread_id = t.id and a.status = 'pending'
             -- A gate under automatic review (PERM2-7) waits on no human.
             and a.decision_state is distinct from 'reviewing') as "awaitingApproval",
           coalesce(
             -- Même précision que le watermark ISO transporté par HTTP.
             date_trunc('milliseconds', activity."lastAttentionAt") > reads.read_at,
             activity."lastAttentionAt" is not null
           ) as unread,
           (hidden.thread_id is not null) as hidden,
           exists(select 1 from runs r where r.organization_id = g.organization_id and r.thread_id = t.id and r.status in ('queued','starting','running','awaiting_approval','relaying','unknown')) as running,
           (select left(coalesce(m.content->0->>'text',''),160) from messages m where m.organization_id = g.organization_id and m.thread_id = t.id order by m.created_at desc limit 1) as preview,
           greatest(
             g.updated_at,
             t.updated_at,
             coalesce(activity."lastActivityAt", '-infinity'::timestamptz)
           ) as "lastActivityAt", g.created_at as "createdAt", g.updated_at as "updatedAt"
      from bot_groups g join threads t on t.organization_id = g.organization_id and t.group_id = g.id
      left join thread_reads reads
        on reads.organization_id = g.organization_id
       and reads.thread_id = t.id
       and reads.user_id = ${userId ?? null}::uuid
      left join thread_hides hidden
        on hidden.organization_id = g.organization_id
       and hidden.thread_id = t.id
       and hidden.user_id = ${userId ?? null}::uuid
      left join lateral (
        select max(item.occurred_at) as "lastActivityAt",
               max(item.occurred_at) filter (where item.attention) as "lastAttentionAt"
          from (
            select m.created_at as occurred_at,
                   (m.role = 'assistant' or coalesce(m.original_author_bot_id, m.author_bot_id) is not null) as attention
              from messages m
             where m.organization_id = g.organization_id and m.thread_id = t.id
            union all
            select event.occurred_at, true
              from run_events event
             where event.organization_id = g.organization_id and event.thread_id = t.id
          ) item
      ) activity on true
     where g.organization_id = ${organizationId}
       and (${groupId ?? null}::uuid is null or g.id = ${groupId ?? null})
       and (${includeHidden}::boolean or hidden.thread_id is null)
     order by g.pinned desc, "lastActivityAt" desc, g.position asc
  `;
  const members = rows.length === 0 ? [] : await tx<MemberRow[]>`
    select gm.group_id as "groupId", b.id, b.name, b.slug, b.face, b.voice_id as "voiceId",
           b.archived_at as "archivedAt", gm.position
      from group_members gm join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
     where gm.organization_id = ${organizationId} and gm.group_id in ${tx(rows.map((row) => row.id))}
     order by gm.group_id, gm.position
  `;
  return groupDtos(rows, members);
}

/**
 * Synchronise l'ajout d'un membre avec l'archivage/suppression, qui prend FOR
 * UPDATE sur le bot avant de vérifier ses salons. Au réveil d'un verrou
 * concurrent, la clause `archived_at` est réévaluée avant toute mutation du
 * roster. Rend les identifiants des bots actifs parmi `memberIds`.
 */
export async function lockActiveMemberBots(
  tx: TransactionDb,
  organizationId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  const bots = await tx<Array<{ id: string }>>`
    select id from bots where organization_id = ${organizationId}
      and id in ${tx(memberIds)} and archived_at is null
     order by id for key share
  `;
  return bots.map((bot) => bot.id);
}

/** Le prochain rang dans une section de salons (création : aucun salon à exclure). */
export async function nextGroupPosition(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
): Promise<number> {
  return nextSectionRowPosition(tx, organizationId, sectionId);
}

/** Le prochain rang dans la section visée par un déplacement : le salon déplacé ne compte pas. */
export async function nextGroupPositionExcluding(
  tx: TransactionDb,
  organizationId: string,
  sectionId: string,
  groupId: string,
): Promise<number> {
  return nextSectionRowPosition(tx, organizationId, sectionId, { kind: "group", id: groupId });
}

export async function insertGroup(
  tx: TransactionDb,
  input: {
    id: string;
    threadId: string;
    organizationId: string;
    sectionId: string;
    name: string;
    instructions: string;
    defaultResponder: unknown;
    answerMode: "each" | "team";
    position: number;
    memberIds: readonly string[];
  },
): Promise<void> {
  await tx`
    insert into bot_groups (id, organization_id, section_id, name, instructions, default_responder, answer_mode, position)
    values (${input.id}, ${input.organizationId}, ${input.sectionId}, ${input.name}, ${input.instructions}, ${input.defaultResponder}, ${input.answerMode}, ${input.position})
  `;
  await insertGroupThread(tx, {
    threadId: input.threadId,
    organizationId: input.organizationId,
    groupId: input.id,
    title: input.name,
  });
  await insertGroupMembers(tx, input.organizationId, input.id, input.memberIds);
}

async function insertGroupMembers(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
  memberIds: readonly string[],
): Promise<void> {
  for (let position = 0; position < memberIds.length; position += 1) {
    await tx`
      insert into group_members (organization_id, group_id, bot_id, position)
      values (${organizationId}, ${groupId}, ${memberIds[position]!}, ${position})
    `;
  }
}

/** Les runs actifs du salon, verrouillés dans un ordre déterministe (hors passes de maintenance). */
export function lockActiveGroupRuns(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
): Promise<Array<{ id: string }>> {
  return tx<Array<{ id: string }>>`
    select run.id from runs run
     where run.organization_id = ${organizationId}
       and run.thread_id in (
         select thread.id from threads thread
          where thread.organization_id = ${organizationId} and thread.group_id = ${groupId}
       )
       and run.status in ('queued','starting','running','awaiting_approval','relaying','unknown')
       and (run.step_kind is null or run.step_kind not in ('memory', 'compaction'))
     order by run.id for update of run
  `;
}

/** Relecture sans nouveau verrou après le verrou groupe/thread, pour détecter un insert concurrent désormais visible. */
export function readActiveGroupRuns(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
): Promise<Array<{ id: string }>> {
  return tx<Array<{ id: string }>>`
    select run.id from runs run
     where run.organization_id = ${organizationId}
       and run.thread_id in (
         select thread.id from threads thread
          where thread.organization_id = ${organizationId} and thread.group_id = ${groupId}
       )
       and run.status in ('queued','starting','running','awaiting_approval','relaying','unknown')
       and (run.step_kind is null or run.step_kind not in ('memory', 'compaction'))
     order by run.id limit 1
  `;
}

/** Verrouille le salon et son fil, et rend sa règle de réponse courante. */
export async function lockGroupWithResponder(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
): Promise<{ id: string; threadId: string; defaultResponder: unknown } | null> {
  const groups = await tx<Array<{ id: string; threadId: string; defaultResponder: unknown }>>`
    select g.id, t.id as "threadId", g.default_responder as "defaultResponder" from bot_groups g
      join threads t on t.organization_id = g.organization_id and t.group_id = g.id
     where g.organization_id = ${organizationId} and g.id = ${groupId}
     for update of g, t
  `;
  return groups[0] ?? null;
}

/** Verrouille le salon et son fil. */
export async function lockGroup(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
): Promise<{ id: string; threadId: string } | null> {
  const groups = await tx<Array<{ id: string; threadId: string }>>`
    select g.id, t.id as "threadId" from bot_groups g
      join threads t on t.organization_id = g.organization_id and t.group_id = g.id
     where g.organization_id = ${organizationId} and g.id = ${groupId}
     for update of g, t
  `;
  return groups[0] ?? null;
}

export async function readGroupMemberIds(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
): Promise<string[]> {
  const members = await tx<Array<{ id: string }>>`
    select bot_id as id from group_members
     where organization_id = ${organizationId} and group_id = ${groupId}
     order by position
  `;
  return members.map((member) => member.id);
}

/** `false` si le salon a disparu entre le verrou et l'écriture. */
export async function updateGroupRow(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
  patch: {
    name: string | null;
    instructions: string | null;
    defaultResponder: unknown;
    answerMode: "each" | "team" | null;
    sectionId: string | null;
    position: number | null;
    pinned: boolean | null;
  },
): Promise<boolean> {
  const updated = await tx<Array<{ id: string }>>`
    update bot_groups set name = coalesce(${patch.name}, name),
      instructions = coalesce(${patch.instructions}, instructions),
      default_responder = ${patch.defaultResponder},
      answer_mode = coalesce(${patch.answerMode}, answer_mode),
      section_id = coalesce(${patch.sectionId}, section_id),
      position = coalesce(${patch.position}, position),
      pinned = coalesce(${patch.pinned}, pinned),
      pin_position = case when ${patch.pinned}::boolean is false then null else pin_position end, updated_at = now()
     where organization_id = ${organizationId} and id = ${groupId} returning id
  `;
  return Boolean(updated[0]);
}

/** Remplace tous les membres du salon, dans l'ordre donné. */
export async function replaceGroupMembers(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
  memberIds: readonly string[],
): Promise<void> {
  await tx`delete from group_members where organization_id = ${organizationId} and group_id = ${groupId}`;
  await insertGroupMembers(tx, organizationId, groupId, memberIds);
}

/** Un message idempotent encore réservé ou en quarantaine sur le fil du salon. */
export async function hasPendingGroupIngress(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
): Promise<boolean> {
  const ingress = await tx<Array<{ id: string }>>`
    select id from message_ingress where organization_id = ${organizationId}
      and thread_id = ${threadId} and state in ('reserved','abandoned')
     limit 1 for update
  `;
  return Boolean(ingress[0]);
}

/** `true` si le salon existait (son fil, ses membres et ses routines suivent en cascade). */
export async function deleteGroupRow(
  tx: TransactionDb,
  organizationId: string,
  groupId: string,
): Promise<boolean> {
  const gone = await tx<Array<{ id: string }>>`
    delete from bot_groups where organization_id = ${organizationId} and id = ${groupId}
    returning id
  `;
  return Boolean(gone[0]);
}

/** Un message du salon mentionne l'opérateur : le salon lève « needs you ». */
export async function raiseGroupNeedsYou(tx: Db, organizationId: string, groupId: string | null): Promise<void> {
  await tx`
    update bot_groups set needs_you = true, updated_at = now()
     where organization_id = ${organizationId} and id = ${groupId}
  `;
}

/** Une routine vient de parler au salon : l'opérateur n'est plus attendu. */
export async function clearGroupNeedsYou(tx: Db, organizationId: string, groupId: string | null): Promise<void> {
  await tx`
    update bot_groups set needs_you = false, updated_at = now()
     where organization_id = ${organizationId} and id = ${groupId}
  `;
}
