import type { SQL } from "bun";
import { withTenant } from "@openedbot/platform-db";
import { countFoldableRoomMessages } from "./compact-thread";


export type RoomCompactionSpeaker = {
  botId: string;
  /** Profil Hermes du membre (relais uniquement ; un runtime direct l'ignore). */
  profile: string | null;
  model: string | null;
  reasoningEffort: string | null;
};

export type RoomCompactionTarget =
  | { kind: "not_found" }
  | { kind: "not_room" }
  | { kind: "run_active" }
  /** Le salon tient déjà dans la queue récente : rien à plier. */
  | { kind: "below_threshold" }
  | {
      kind: "ready";
      speaker: RoomCompactionSpeaker;
      /** `global` impose le modèle du runtime à tous les membres. */
      assignmentMode: "global" | "per_bot";
      operatorName: string | null;
      foldable: number;
    };

/**
 * Ce qu'il faut savoir d'un salon pour le compacter à la demande (DEV-332), lu
 * sous le rôle de l'API (`withTenant` : `threads`, `runs`, `messages` sont sous
 * RLS). Les refus sont rendus comme des valeurs, la route choisit les codes HTTP.
 *
 * La compaction est par fil, pas par membre, mais elle tourne sur la session
 * d'un membre. On prend celui qui a parlé en dernier : c'est lui dont le modèle
 * et le profil sont les plus sûrement vivants (il vient de répondre), et sa
 * jauge est celle que l'opérateur a probablement sous les yeux. Sans message
 * de membre (salon où seul l'opérateur a écrit), le premier membre du salon.
 */
export async function readRoomCompactionTarget(
  db: SQL,
  organizationId: string,
  threadId: string,
): Promise<RoomCompactionTarget> {
  const read = await withTenant(db, organizationId, async (tx) => {
    const threads = await tx<Array<{ groupId: string | null; assignmentMode: string | null; operatorName: string | null }>>`
      select t.group_id as "groupId",
             (select o.model_assignment_mode from organizations o where o.id = t.organization_id) as "assignmentMode",
             (select op.username from operator_profiles op where op.organization_id = t.organization_id limit 1) as "operatorName"
        from threads t
       where t.organization_id = ${organizationId} and t.id = ${threadId}
    `;
    const thread = threads[0];
    if (!thread) return { kind: "not_found" as const };
    if (!thread.groupId) return { kind: "not_room" as const };
    // Statuts non terminaux : tant qu'un run existe, le salon est en train de bouger.
    const active = await tx<Array<{ active: boolean }>>`
      select exists(
        select 1 from runs
         where organization_id = ${organizationId} and thread_id = ${threadId}
           and status in ('queued', 'starting', 'running', 'awaiting_approval')
      ) as active
    `;
    if (active[0]?.active) return { kind: "run_active" as const };
    const speakers = await tx<Array<{
      botId: string; profile: string | null; model: string | null; reasoningEffort: string | null;
    }>>`
      select b.id as "botId", b.hermes_profile as profile, b.model, b.reasoning_effort as "reasoningEffort"
        from bots b
       where b.organization_id = ${organizationId} and b.archived_at is null and b.deleted_at is null
         and b.id in (
           select gm.bot_id from group_members gm
            where gm.organization_id = ${organizationId} and gm.group_id = ${thread.groupId}
         )
       order by (
                select max(m.sequence) from messages m
                 where m.organization_id = b.organization_id and m.thread_id = ${threadId}
                   and m.author_bot_id = b.id
              ) desc nulls last,
              (select gm.position from group_members gm
                where gm.organization_id = b.organization_id and gm.group_id = ${thread.groupId}
                  and gm.bot_id = b.id) asc
       limit 1
    `;
    const speaker = speakers[0];
    if (!speaker) return { kind: "not_room" as const };
    return {
      kind: "found" as const,
      speaker,
      assignmentMode: thread.assignmentMode === "global" ? ("global" as const) : ("per_bot" as const),
      operatorName: thread.operatorName,
    };
  });
  if (read.kind !== "found") return read;
  const foldable = await countFoldableRoomMessages(db, { organizationId, threadId });
  if (foldable === 0) return { kind: "below_threshold" };
  return {
    kind: "ready",
    speaker: read.speaker,
    assignmentMode: read.assignmentMode,
    operatorName: read.operatorName,
    foldable,
  };
}
