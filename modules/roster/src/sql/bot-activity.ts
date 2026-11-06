import type { BotToolUsageDto, ToolErrorDto, ToolErrorPageDto } from "@openedbot/contracts-api";
import { insertPersonaDraftThreadIfAbsent } from "@openedbot/conversation/application/threads";
import type { TransactionDb } from "@openedbot/platform-db";

/** Le bot existe-t-il pour cette organisation ? */
export async function botExists(tx: TransactionDb, organizationId: string, botId: string): Promise<boolean> {
  const bots = await tx<Array<{ id: string }>>`
    select id from bots where organization_id = ${organizationId} and id = ${botId}
  `;
  return Boolean(bots[0]);
}

/**
 * Les outils que CE bot a réellement appelés, par nom.
 *
 * `run_events` est un tampon de livraison purgé au-delà de la rétention
 * (0012) : cette liste est datée, pas exhaustive, et l'appelant publie la
 * fenêtre avec elle. Un `tool.result` dont le `tool.call` a été purgé donne
 * un groupe à zéro appel ; il tombe, plutôt que d'afficher « 0 appel,
 * 3 échecs », qui ne décrit rien.
 */
export async function readToolUsage(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<BotToolUsageDto[]> {
  const rows = await tx<Array<{ tool: string; calls: number; failures: number; lastUsedAt: Date | string }>>`
    select event.payload->>'tool' as tool,
           count(*) filter (where event.type = 'tool.call')::int as calls,
           count(*) filter (where event.type = 'tool.result' and event.payload->>'error' = 'true')::int as failures,
           max(event.occurred_at) filter (where event.type = 'tool.call') as "lastUsedAt"
      from run_events event
      join runs run on run.organization_id = event.organization_id and run.id = event.run_id
     where event.organization_id = ${organizationId}
       and run.bot_id = ${botId}
       and event.type in ('tool.call', 'tool.result')
       and event.payload->>'tool' is not null
     group by 1
    having count(*) filter (where event.type = 'tool.call') > 0
     order by calls desc, tool asc
     limit 200
  `;
  return rows.map((row) => ({
    tool: row.tool,
    calls: row.calls,
    failures: row.failures,
    lastUsedAt: new Date(row.lastUsedAt).toISOString(),
  }));
}

type ToolErrorRow = {
  id: string;
  botId: string;
  threadId: string;
  runId: string;
  userId: string | null;
  tool: string;
  toolCallId: string;
  errorMessage: string | null;
  durationMs: number | null;
  occurredAt: Date | string;
};

/**
 * Les échecs d'outils d'un bot, les plus récents d'abord. Ils sortent de
 * `tool_errors`, pas de `run_events` : ils survivent à la purge du tampon
 * SSE et se lisent par l'index `(organization_id, bot_id, occurred_at desc)`.
 */
export async function readToolErrors(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  limit: number,
  cursor: { occurredAt: string; id: string } | null,
): Promise<ToolErrorPageDto> {
  const rows = await tx<ToolErrorRow[]>`
    select id, bot_id as "botId", thread_id as "threadId", run_id as "runId", user_id as "userId",
           tool, tool_call_id as "toolCallId", error_message as "errorMessage",
           duration_ms as "durationMs", occurred_at as "occurredAt"
      from tool_errors
     where organization_id = ${organizationId}
       and bot_id = ${botId}
       and (${cursor === null} or
            (occurred_at, id) < (${cursor?.occurredAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
     order by occurred_at desc, id desc
     limit ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const errors: ToolErrorDto[] = page.map((row) => ({
    id: row.id,
    botId: row.botId,
    threadId: row.threadId,
    runId: row.runId,
    userId: row.userId,
    tool: row.tool,
    toolCallId: row.toolCallId,
    errorMessage: row.errorMessage,
    durationMs: row.durationMs,
    occurredAt: new Date(row.occurredAt).toISOString(),
  }));
  return {
    errors,
    nextCursor: rows.length > limit && last ? `${new Date(last.occurredAt).toISOString()}|${last.id}` : null,
  };
}

/** Le bot actif et son fil par défaut, verrouillés pour qu'un seul brouillon de persona parte à la fois. */
export async function lockBotForPersonaDraft(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<{ id: string; name: string; threadId: string } | null> {
  const bots = await tx<Array<{ id: string; name: string; threadId: string }>>`
    select b.id, b.name, t.id as "threadId"
      from bots b
      join threads t on t.organization_id = b.organization_id and t.bot_id = b.id
        and t.is_default
     where b.organization_id = ${organizationId} and b.id = ${botId} and b.archived_at is null
     for update of b
  `;
  return bots[0] ?? null;
}

export async function hasActivePersonaDraftRun(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<boolean> {
  const busy = await tx<Array<{ id: string }>>`
    select id from runs
     where organization_id = ${organizationId} and bot_id = ${botId}
       and step_kind = 'persona_draft'
       and status in ('queued','starting','running','awaiting_approval','relaying','unknown')
     limit 1
  `;
  return Boolean(busy[0]);
}

/** Les derniers messages du fil, du plus récent au plus ancien. */
export function readThreadHistory(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  limit: number,
): Promise<Array<{ role: string; content: unknown }>> {
  return tx<Array<{ role: string; content: unknown }>>`
    select role, content from messages
     where organization_id = ${organizationId} and thread_id = ${threadId}
       and role in ('user', 'assistant')
     order by created_at desc, id desc
     limit ${limit}
  `;
}

/** Le fil des brouillons de persona du bot, créé au besoin ; rend son identifiant. */
export async function ensurePersonaDraftThread(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  title: string,
  sessionKey: string,
): Promise<string> {
  await insertPersonaDraftThreadIfAbsent(tx, organizationId, botId, title, sessionKey);
  const [draftThread] = await tx<Array<{ id: string }>>`
    select id from threads
     where organization_id = ${organizationId} and hermes_session_id = ${sessionKey}
  `;
  return draftThread!.id;
}

/** Le dernier brouillon du bot, ou `null` s'il n'en a jamais demandé. */
export async function readLatestPersonaDraftRun(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
): Promise<{ id: string; status: string; output: string | null } | null> {
  const rows = await tx<Array<{
    id: string;
    status: string;
    output: string | null;
  }>>`
    select id, status, output from runs
     where organization_id = ${organizationId} and bot_id = ${botId}
       and step_kind = 'persona_draft'
     order by created_at desc, id desc
     limit 1
  `;
  return rows[0] ?? null;
}

export async function readPersonaDraftRun(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  runId: string,
): Promise<{ output: string | null; status: string } | null> {
  const run = (await tx<Array<{ output: string | null; status: string }>>`
    select output, status from runs
     where organization_id = ${organizationId} and bot_id = ${botId}
       and id = ${runId} and step_kind = 'persona_draft'
     limit 1
  `)[0];
  return run ?? null;
}

/** Applique la persona confirmée ; `false` si le bot a disparu. */
export async function setBotInstructions(
  tx: TransactionDb,
  organizationId: string,
  botId: string,
  instructions: string,
): Promise<boolean> {
  const updated = await tx<Array<{ id: string }>>`
    update bots set instructions = ${instructions}, updated_at = now()
     where organization_id = ${organizationId} and id = ${botId}
    returning id
  `;
  return Boolean(updated[0]);
}
