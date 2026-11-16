import type { TransactionDb } from "@openedbot/platform-db";
import { stripToolNotes } from "../domain/routine-intent";

/** What a run was asked: the user's text that started it, and where it sits in its thread. */
export type RunIntentInput = {
  threadId: string;
  sourceMessageId: string | null;
  /** The stored input without the tool notes earlier workers appended, then every message steered into the run. */
  message: string;
};

/**
 * The user's request a run answers, for a tool that must check it before it
 * writes (`routine_manage`). A message steered into the live run is part of
 * the request; a steering attempt not confirmed by the runtime is not.
 */
export async function readRunIntentInput(
  tx: TransactionDb,
  organizationId: string,
  runId: string,
): Promise<RunIntentInput | null> {
  const rows = await tx<Array<{ threadId: string; sourceMessageId: string | null; input: string | null; steered: string[] | null }>>`
    select r.thread_id as "threadId", r.source_message_id as "sourceMessageId", r.input,
           (select array_agg(s.text order by s.created_at, s.id)
              from run_steering_attempts s
             where s.organization_id = r.organization_id and s.target_run_id = r.id and s.status = 'confirmed') as steered
      from runs r
     where r.organization_id = ${organizationId} and r.id = ${runId}
  `;
  const row = rows[0];
  if (!row) return null;
  const message = [stripToolNotes(row.input ?? ""), ...(row.steered ?? [])]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");
  return { threadId: row.threadId, sourceMessageId: row.sourceMessageId, message };
}
