import type { SQL } from "bun";
import type { ReplyPromptContext } from "@openedbot/conversation/domain/message-reply";
import type { RunContext } from "./types";

/** Une ligne du fil telle que lue en base, avec l'auteur résolu. */
export type RoomLine = {
  role: string;
  content: unknown;
  runId?: string | null;
  authorBotId: string | null;
  authorName: string | null;
  authorSlug: string | null;
  sequence?: number;
  replyToId?: string | null;
  replyTarget?: (ReplyPromptContext & { organizationId: string; threadId: string }) | null;
};

/** Les 260 dernières lignes du salon vues par ce tour, de la plus récente à la plus ancienne. */
export function readRoomLinesNewestFirst(
  db: SQL,
  context: Pick<RunContext, "id" | "organizationId" | "threadId" | "workflowId">,
): Promise<RoomLine[]> {
  return db<RoomLine[]>`
    select m.role, m.content, m.sequence, m.run_id as "runId", m.reply_to_id as "replyToId",
           coalesce(m.original_author_bot_id, m.author_bot_id) as "authorBotId",
           coalesce(m.original_author_name, ab.name) as "authorName", ab.slug as "authorSlug"
      from messages m
      left join bots ab on ab.organization_id = m.organization_id and ab.id = m.author_bot_id
      left join runs message_run
        on message_run.organization_id = m.organization_id and message_run.id = m.run_id
      left join workflows message_workflow
        on message_workflow.organization_id = message_run.organization_id
       and message_workflow.id = message_run.workflow_id
      left join workflows current_workflow
        on current_workflow.organization_id = m.organization_id
       and current_workflow.id = ${context.workflowId}
     where m.organization_id = ${context.organizationId} and m.thread_id = ${context.threadId}
       -- Le message opérateur qui ouvre l'envoi porte le run_id du premier tour :
       -- seul l'éventuel output assistant du run courant est exclu, jamais l'entrée.
       and (m.run_id is null or m.run_id <> ${context.id} or m.role = 'user')
       -- Un follow-up peut être créé pendant ce tour. Il appartient à un
       -- workflow racine ultérieur : ni ce tour ni les rounds suivants du
       -- workflow courant ne doivent le consommer avant sa propre exécution.
       and (
         current_workflow.id is null or message_workflow.id is null
         or message_workflow.id = current_workflow.id
         or (message_workflow.created_at, message_workflow.id)
              < (current_workflow.created_at, current_workflow.id)
       )
       -- Une consigne opérateur dont l'envoi a été annulé ou a échoué reste
       -- visible dans le salon, mais ne redevient jamais une entrée à traiter
       -- (même règle que conversationHistory). L'entrée du run et du
       -- workflow courants est toujours gardée.
       and (
         m.role <> 'user' or m.run_id is null or m.run_id = ${context.id}
         or message_run.status = 'completed'
         or message_workflow.id = current_workflow.id
       )
     order by m.sequence desc limit 260
  `;
}
