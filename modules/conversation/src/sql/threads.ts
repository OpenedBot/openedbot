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

/** Le fil par défaut d'un bot qui vient d'être créé ou importé. */
export async function insertBotDefaultThread(
  tx: TransactionDb,
  input: { threadId: string; organizationId: string; botId: string; title: string },
): Promise<void> {
  await tx`
    insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${input.threadId}, ${input.organizationId}, ${input.botId}, ${input.title}, ${`openedbot:${input.organizationId}:${input.threadId}`}, true)
  `;
}

/** Le fil d'un salon qui vient d'être créé ou importé. */
export async function insertGroupThread(
  tx: TransactionDb,
  input: { threadId: string; organizationId: string; groupId: string; title: string },
): Promise<void> {
  await tx`
    insert into threads (id, organization_id, group_id, title, hermes_session_id)
    values (${input.threadId}, ${input.organizationId}, ${input.groupId}, ${input.title}, ${`openedbot:${input.organizationId}:group:${input.threadId}`})
  `;
}

/** Un fil vient de recevoir un message ou un événement : il remonte dans la liste. */
export async function touchThread(tx: Db, organizationId: string, threadId: string): Promise<void> {
  await tx`
    update threads set updated_at = now()
     where organization_id = ${organizationId} and id = ${threadId}
  `;
}

/**
 * 0163 : le fil passe à la génération de session suivante, si elle est
 * toujours `expected`. Rendu : la nouvelle génération, ou `null` quand un
 * autre run l'a déjà fait avancer.
 */
export async function advanceThreadSessionGeneration(
  tx: Db,
  organizationId: string,
  threadId: string,
  expected: number,
): Promise<number | null> {
  const rows = await tx<Array<{ generation: number }>>`
    update threads
       set hermes_session_generation = hermes_session_generation + 1, hermes_session_opened_at = now()
     where organization_id = ${organizationId} and id = ${threadId}
       and hermes_session_generation = ${expected}
    returning hermes_session_generation as generation
  `;
  return rows[0] ? Number(rows[0].generation) : null;
}

/** La génération de session courante du fil (0163) ; `null` si le fil n'existe plus. */
export async function readThreadSessionGeneration(tx: Db, organizationId: string, threadId: string): Promise<number | null> {
  const rows = await tx<Array<{ generation: number }>>`
    select hermes_session_generation as generation from threads
     where organization_id = ${organizationId} and id = ${threadId}
  `;
  return rows[0] ? Number(rows[0].generation) : null;
}

/** Premier run servi par la génération `generation` : note son instant d'ouverture, une seule fois. */
export async function markThreadSessionOpened(tx: Db, organizationId: string, threadId: string, generation: number): Promise<void> {
  await tx`
    update threads set hermes_session_opened_at = now()
     where organization_id = ${organizationId} and id = ${threadId}
       and hermes_session_generation = ${generation} and hermes_session_opened_at is null
  `;
}
