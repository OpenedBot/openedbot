import type { Db } from "@openedbot/platform-db";

/**
 * Writes of `messages` on behalf of the run executor. The SQL lives with its
 * owner; the caller passes its own transaction.
 */

/** La bulle d'un bot (ou du run) : rôle `assistant`, auteur facultatif. */
export async function insertAssistantMessage(
  tx: Db,
  input: {
    messageId: string;
    organizationId: string;
    threadId: string;
    runId: string;
    content: unknown;
    authorBotId: string | null;
  },
): Promise<void> {
  await tx`
    insert into messages (id, organization_id, thread_id, run_id, role, content, author_bot_id)
    values (${input.messageId}, ${input.organizationId}, ${input.threadId}, ${input.runId},
            'assistant', ${input.content},
            ${input.authorBotId})
  `;
}

/** Le message d'entrée d'un run lancé par une routine : rôle `user`, sans auteur. */
export async function insertRoutineInputMessage(
  tx: Db,
  input: { organizationId: string; threadId: string; runId: string; text: string },
): Promise<void> {
  await tx`
    insert into messages (id, organization_id, thread_id, run_id, role, content)
    values (${crypto.randomUUID()}, ${input.organizationId}, ${input.threadId}, ${input.runId},
            'user', ${[{ type: "text", text: input.text }]})
  `;
}

/** L'entrée d'un bot délégué : rôle `user`, attribuée au bot d'origine. */
export async function insertHandoffInboundMessage(
  tx: Db,
  input: {
    organizationId: string;
    threadId: string;
    runId: string;
    text: string;
    authorBotId: string | null;
  },
): Promise<void> {
  await tx`
    insert into messages (id, organization_id, thread_id, run_id, role, content, author_bot_id)
    values (${crypto.randomUUID()}, ${input.organizationId}, ${input.threadId}, ${input.runId},
            'user', ${[{ type: "text", text: input.text }]}, ${input.authorBotId})
  `;
}

/** La réponse d'un bot délégué, déposée sur le fil d'origine. */
export async function insertHandoffReplyMessage(
  tx: Db,
  input: {
    messageId: string;
    organizationId: string;
    threadId: string;
    runId: string;
    text: string;
    authorBotId: string | null;
  },
): Promise<void> {
  await tx`
    insert into messages (id, organization_id, thread_id, run_id, role, content, author_bot_id)
    values (${input.messageId}, ${input.organizationId}, ${input.threadId}, ${input.runId},
            -- role 'user' : c'est une ENTRÉE du fil d'origine (le client rend
            -- BotInboundMessage pour un message user attribué à un bot).
            'user', ${[{ type: "text", text: input.text }]}, ${input.authorBotId})
  `;
}
