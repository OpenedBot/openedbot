import type { Db, TransactionDb } from "@openedbot/platform-db";

/**
 * Writes of `threads` on behalf of other contexts (roster, portability,
 * execution). The SQL lives with its owner; the caller passes its own
 * transaction, so the write stays in the caller's unit of work.
 */

/** Le fil des brouillons de persona du bot, créé au besoin (`on conflict do nothing`). */
export async function insertPersonaDraftThreadIfAbsent(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  title: string,
  sessionKey: string,
): Promise<void> {
  await tx`
    insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${crypto.randomUUID()}, ${organizationId}, ${botId}, ${title}, ${sessionKey}, false)
    on conflict (organization_id, hermes_session_id) do nothing
  `;
}

/** Le fil d'un brouillon proposé avant que le bot existe (assistant de création). */
export async function insertCreationDraftThread(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  title: string,
  sessionId: string,
): Promise<void> {
  await tx`
    insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${threadId}, ${organizationId}, null, ${title}, ${sessionId}, false)
  `;
}

/** Le fil par défaut d'un bot qui vient d'être créé ou importé. */
export async function insertBotDefaultThread(
  tx: TransactionDb,
  input: { threadId: string; organizationId: string; botId: string; title: string },
): Promise<void> {
  await tx`
    insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${input.threadId}, ${input.organizationId}, ${input.botId}, ${input.title}, ${`ohb:${input.organizationId}:${input.threadId}`}, true)
  `;
}

/** Le fil d'un salon qui vient d'être créé ou importé. */
export async function insertGroupThread(
  tx: TransactionDb,
  input: { threadId: string; organizationId: string; groupId: string; title: string },
): Promise<void> {
  await tx`
    insert into threads (id, organization_id, group_id, title, hermes_session_id)
    values (${input.threadId}, ${input.organizationId}, ${input.groupId}, ${input.title}, ${`ohb:${input.organizationId}:group:${input.threadId}`})
  `;
}

/** Un fil vient de recevoir un message ou un événement : il remonte dans la liste. */
export async function touchThread(tx: Db, organizationId: string, threadId: string): Promise<void> {
  await tx`
    update threads set updated_at = now()
     where organization_id = ${organizationId} and id = ${threadId}
  `;
}
