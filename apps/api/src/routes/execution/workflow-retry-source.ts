import type { TransactionDb } from "@openedbot/platform-db";

/** Le run racine qu'une relance rejoue, verrouillé, avec les restrictions de son tour. */
export type RetrySource = {
  botId: string | null;
  input: string;
  model: string | null;
  stepKind: "root" | "delegated" | "group" | null;
  stackDepth: number;
  callerBotId: string | null;
  groupTurnPosition: number | null;
  groupState: unknown;
  /** Le plan demandé sur le run ou sur son workflow : une relance ne l'élargit jamais. */
  planOnly: boolean;
  neverWait: boolean;
  /**
   * Le message opérateur dont la relance relit les images : celui du run
   * d'origine, hérité le long d'une chaîne de relances (0173).
   */
  sourceMessageId: string | null;
};

export async function readRetrySource(
  tx: TransactionDb,
  organizationId: string,
  rootRunId: string,
): Promise<RetrySource | undefined> {
  const rows = await tx<RetrySource[]>`
    select run.bot_id as "botId", run.input, run.model, run.step_kind as "stepKind",
           run.stack_depth as "stackDepth", run.caller_bot_id as "callerBotId",
           run.group_turn_position as "groupTurnPosition", run.group_state as "groupState",
           (run.plan_only or source.plan_only) as "planOnly", source.never_wait as "neverWait",
           coalesce(run.source_message_id, (
             select message.id from messages message
              where message.organization_id = run.organization_id and message.run_id = run.id
                and message.role = 'user'
              order by message.sequence asc limit 1
           )) as "sourceMessageId"
      from runs run
      join workflows source on source.organization_id = run.organization_id and source.id = run.workflow_id
     where run.organization_id = ${organizationId} and run.id = ${rootRunId}
     limit 1 for update of run
  `;
  return rows[0];
}
