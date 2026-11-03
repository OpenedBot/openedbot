import type { TransactionDb } from "@openedbot/platform-db";

/** Un run `persona_draft` en file, sur le fil de brouillon d'un bot. */
export async function insertPersonaDraftRun(
  tx: TransactionDb,
  input: {
    organizationId: string;
    threadId: string;
    botId: string;
    prompt: string;
    sessionKey: string;
  },
): Promise<string> {
  const runId = crypto.randomUUID();
  await tx`
    insert into runs (
      id, organization_id, thread_id, bot_id, input, status,
      step_kind, stack_depth, execution_session_key, external_state, events_complete
    ) values (
      ${runId}, ${input.organizationId}, ${input.threadId}, ${input.botId}, ${input.prompt},
      'queued', 'persona_draft', 0, ${input.sessionKey},
      'not_started', true
    )
  `;
  return runId;
}

/** Un premier message caché en file, sans message opérateur associé. */
export async function insertBotGreetingRun(
  tx: TransactionDb,
  input: {
    organizationId: string;
    threadId: string;
    botId: string;
    initiatorUserId: string;
    input: string;
  },
): Promise<string> {
  const runId = crypto.randomUUID();
  await tx`
    insert into runs (
      id, organization_id, thread_id, bot_id, group_turn_position, group_state, input, status,
      workflow_id, step_index, step_kind, stack_depth, caller_bot_id, execution_session_key,
      external_state, events_complete, initiator_user_id, deadline_at, origin
    ) values (
      ${runId}, ${input.organizationId}, ${input.threadId}, ${input.botId}, null, null, ${input.input}, 'queued',
      null, 0, 'root', 0, null, null, 'not_started', true,
      ${input.initiatorUserId},
      now() + ((select autonomy_timeout_seconds from bots
                 where organization_id = ${input.organizationId} and id = ${input.botId}) * interval '1 second'),
      'bot_greeting'
    )
  `;
  return runId;
}
