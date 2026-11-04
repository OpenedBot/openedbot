import type { MessageContent } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";

/** Le message opérateur dont on crée une variante, avec les restrictions de son tour. */
export type SourceRow = {
  threadId: string;
  threadTitle: string;
  botId: string | null;
  botName: string | null;
  botSlug: string | null;
  messageId: string;
  role: "user" | "assistant";
  content: MessageContent;
  authorBotId: string | null;
  initiatorUserId: string | null;
  sequence: number | string;
  planOnly: boolean;
  neverWait: boolean;
};

export async function readSource(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  messageId: string,
  lock: boolean,
): Promise<SourceRow | null> {
  const rows = lock
    ? await tx<SourceRow[]>`
        select thread.id as "threadId", thread.title as "threadTitle",
               thread.bot_id as "botId", bot.name as "botName", bot.slug as "botSlug",
               message.id as "messageId", message.role, message.content,
               message.author_bot_id as "authorBotId",
               coalesce(workflow.initiator_user_id, message_run.initiator_user_id) as "initiatorUserId",
               message.sequence,
               coalesce(message_run.plan_only, false) or coalesce(workflow.plan_only, false) as "planOnly",
               coalesce(workflow.never_wait, false) as "neverWait"
          from threads thread
          join messages message on message.organization_id = thread.organization_id and message.thread_id = thread.id
          left join bots bot on bot.organization_id = thread.organization_id and bot.id = thread.bot_id
          left join runs message_run on message_run.organization_id = message.organization_id
            and message_run.id = message.run_id
          left join workflows workflow on workflow.organization_id = message_run.organization_id
            and workflow.id = message_run.workflow_id
         where thread.organization_id = ${organizationId} and thread.id = ${threadId} and message.id = ${messageId}
         for update of thread
      `
    : await tx<SourceRow[]>`
        select thread.id as "threadId", thread.title as "threadTitle",
               thread.bot_id as "botId", bot.name as "botName", bot.slug as "botSlug",
               message.id as "messageId", message.role, message.content,
               message.author_bot_id as "authorBotId",
               coalesce(workflow.initiator_user_id, message_run.initiator_user_id) as "initiatorUserId",
               message.sequence,
               coalesce(message_run.plan_only, false) or coalesce(workflow.plan_only, false) as "planOnly",
               coalesce(workflow.never_wait, false) as "neverWait"
          from threads thread
          join messages message on message.organization_id = thread.organization_id and message.thread_id = thread.id
          left join bots bot on bot.organization_id = thread.organization_id and bot.id = thread.bot_id
          left join runs message_run on message_run.organization_id = message.organization_id
            and message_run.id = message.run_id
          left join workflows workflow on workflow.organization_id = message_run.organization_id
            and workflow.id = message_run.workflow_id
         where thread.organization_id = ${organizationId} and thread.id = ${threadId} and message.id = ${messageId}
      `;
  return rows[0] ?? null;
}

export function assertSourceEligible(source: SourceRow | null, userId: string): asserts source is SourceRow {
  if (!source) throw new HttpError(404, "MESSAGE_NOT_FOUND", "Message introuvable dans cette conversation.");
  if (!source.botId) {
    throw new HttpError(409, "MESSAGE_VERSION_DM_REQUIRED", "Les variantes sont réservées au fil d’un bot.");
  }
  if (source.role !== "user" || source.authorBotId) {
    throw new HttpError(409, "MESSAGE_VERSION_USER_REQUIRED", "Seul un message de l’opérateur peut être modifié ou régénéré.");
  }
  if (!source.initiatorUserId || source.initiatorUserId !== userId) {
    throw new HttpError(
      403,
      "MESSAGE_VERSION_AUTHOR_REQUIRED",
      "Seul l’auteur de ce message peut en créer une variante.",
    );
  }
}
