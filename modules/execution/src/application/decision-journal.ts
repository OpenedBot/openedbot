import { createHash } from "node:crypto";

export type DecisionChoice = "once" | "deny";

export type DecisionEnvelope = {
  version: 1;
  organizationId: string;
  approvalRequestId?: string | null;
  memoryId?: string | null;
  threadId: string;
  runId: string;
  actorUserId: string;
  choice: DecisionChoice;
  occurredAt: string;
  botId: string | null;
  botName: string | null;
  action: string;
  kind: string;
  /** PERM2-4: the grant an "Always for this tool on this bot" recorded with this `once`. */
  grantId?: string;
  /** PERM2-4: the runtime switch an "Always" on a dangerous command turned on with this `once`. */
  runtimeSettingId?: string;
};

export type AppendDecisionInput = {
  organizationId: string;
  threadId: string;
  runId: string;
  approvalRequestId?: string | null;
  actorUserId: string;
  choice: DecisionChoice;
  envelope: DecisionEnvelope;
};

/**
 * Append d'une ligne au journal hash-chaîné `decisions`. L'advisory lock sérialise
 * la chaîne par tenant : `created_at` n'est pas l'ordre d'append.
 */
export async function appendDecisionTx(
  tx: Bun.TransactionSQL,
  input: AppendDecisionInput,
): Promise<{ id: string; entryHash: string }> {
  await tx`
    select pg_advisory_xact_lock(
      hashtext(${input.organizationId}),
      hashtext('ohb-decisions-chain')
    )
  `;
  const previousRows = await tx<Array<{ entryHash: string; chainSequence: string | number }>>`
    select entry_hash as "entryHash", chain_sequence as "chainSequence" from decisions
     where organization_id = ${input.organizationId} order by chain_sequence desc limit 1
  `;
  const previousHash = previousRows[0]?.entryHash ?? null;
  const chainSequence = Number(previousRows[0]?.chainSequence ?? 0) + 1;
  const entryHash = createHash("sha256")
    .update(`${previousHash ?? ""}\n${JSON.stringify(input.envelope)}`)
    .digest("hex");
  const id = crypto.randomUUID();
  await tx`
    insert into decisions (
      id, organization_id, thread_id, run_id, approval_request_id, actor_user_id,
      choice, envelope, previous_hash, entry_hash, chain_sequence
    ) values (
      ${id}, ${input.organizationId}, ${input.threadId}, ${input.runId},
      ${input.approvalRequestId ?? null}, ${input.actorUserId}, ${input.choice},
      ${input.envelope}, ${previousHash}, ${entryHash}, ${chainSequence}
    )
  `;
  return { id, entryHash };
}
