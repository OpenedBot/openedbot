import type { SQL } from "bun";
import { ACTIVE_RUN_STATUSES } from "../domain/run-transitions";
import { appendLeaseFence, SqlStatement, type LeaseFence } from "./run-transitions";

/**
 * The writes of `runs` that are not transitions (ADR 0001 S2d): one named
 * statement per column group, none of which touches `status`,
 * `external_state` or `remote_stop_state` (`sql/run-transitions.ts` alone
 * does, `tests/scripts/run-writes-contract.ts` holds both rules). A worker's
 * write carries the same lease fence as its transitions.
 */

type RunKey = { readonly organizationId: string; readonly id: string };

const ACTIVE = `(${ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ")})`;

function whereRun(statement: SqlStatement, run: RunKey): SqlStatement {
  return statement.text(" where id = ").value(run.id).text(" and organization_id = ").value(run.organizationId);
}

export type RenewedLease = {
  status: string;
  remoteStopState: "requested" | "confirmed" | "ambiguous" | "failed" | null;
  errorCode: string | null;
  errorMessage: string | null;
};

/**
 * The worker's heartbeat: extends its unexpired lease on an active run and
 * reads back what the API may have asked meanwhile (a stop). Null when the
 * lease is gone: expired, taken over, or the run left the active states.
 */
export async function renewRunLease(db: SQL, run: RunKey, fence: LeaseFence, leaseSeconds: number): Promise<RenewedLease | null> {
  const statement = new SqlStatement()
    .text("update runs set heartbeat_at = now(), lease_expires_at = now() + (").value(leaseSeconds)
    .text(" * interval '1 second'), updated_at = now()");
  whereRun(statement, run);
  appendLeaseFence(statement, fence).text(` and status in ${ACTIVE}`)
    .text(` returning status, remote_stop_state as "remoteStopState", error_code as "errorCode", error_message as "errorMessage"`);
  const rows = await statement.run<RenewedLease[]>(db);
  return rows[0] ?? null;
}

/** The model of a provider retry, written while the create is still pending. */
export async function recordCreatingRunModel(db: SQL, run: RunKey, fence: LeaseFence, model: string | null): Promise<void> {
  const statement = new SqlStatement().text("update runs set model = ").value(model).text(", updated_at = now()");
  whereRun(statement, run);
  appendLeaseFence(statement, fence).text(" and status in ('starting') and external_state in ('creating')");
  await statement.run(db);
}

/**
 * The Hermes stream watermark (`last_hermes_sequence`). Under the lease for
 * the stream; by generation only, with the heartbeat, at the end of the
 * transaction that wrote the events it covers (`persistEvents`): that
 * transaction locked the run under the lease first, and a terminal event in it
 * has already released the lease.
 */
export async function advanceHermesWatermark(
  sql: SQL,
  run: RunKey,
  guard: LeaseFence | { readonly generation: number },
  rawSequence: number,
): Promise<void> {
  const locked = "generation" in guard;
  const statement = new SqlStatement().text("update runs set last_hermes_sequence = ").value(rawSequence)
    .text(locked ? ", heartbeat_at = now(), updated_at = now()" : ", updated_at = now()");
  whereRun(statement, run);
  if (locked) statement.text(" and lease_generation = ").value(guard.generation);
  else appendLeaseFence(statement, guard);
  await statement.run(sql);
}

/**
 * How a step ended for its workflow (`completion_kind`, and its kept output
 * when there is one), on the run the caller holds locked. A fold marks the
 * follow-ups merged into a replayed one.
 */
export async function recordRunCompletionKindTx(
  tx: SQL,
  runs: { readonly organizationId: string; readonly ids: readonly string[] },
  completionKind: string,
  output?: string | null,
): Promise<void> {
  if (runs.ids.length === 0) return;
  const statement = new SqlStatement().text("update runs set completion_kind = ").value(completionKind);
  if (output !== undefined) statement.text(", output = ").value(output);
  statement.text(", updated_at = now() where organization_id = ").value(runs.organizationId).text(" and id in (");
  runs.ids.forEach((id, index) => { if (index) statement.text(", "); statement.value(id); });
  await statement.text(")").run(tx);
}

/**
 * The latency record of a finished run (0151). Bounded by the lease
 * generation only: the lease was released with the run, and a worker that
 * lost the run does not overwrite the record of the one that took it over.
 */
export function saveRunTimingsRecord(
  db: SQL,
  run: RunKey & { readonly leaseGeneration: number },
  timings: Record<string, unknown>,
): Promise<unknown> {
  return db`
    update runs set timings = ${timings}::jsonb
     where organization_id = ${run.organizationId} and id = ${run.id}
       and lease_generation = ${run.leaseGeneration}
  `;
}

/** Pins the Hermes session of a claimed run, before its create. False when the lease or the slot is gone. */
export async function pinRunSessionKey(db: SQL, run: RunKey, fence: LeaseFence, sessionKey: string): Promise<boolean> {
  const statement = new SqlStatement().text("update runs set execution_session_key = ").value(sessionKey).text(", updated_at = now()");
  whereRun(statement, run);
  appendLeaseFence(statement, fence).text(" and execution_session_key is null and hermes_run_id is null returning id");
  const rows = await statement.run<Array<{ id: string }>>(db);
  return rows.length > 0;
}

/** A message folded into the input of a queued run nobody claimed yet. */
export async function foldQueuedRunInputTx(tx: SQL, run: RunKey, input: string): Promise<void> {
  await tx`
    update runs set input = case when input = '' then ${input} else input || E'\n\n' || ${input} end,
      updated_at = now()
     where organization_id = ${run.organizationId} and id = ${run.id}
       and status in ('queued') and hermes_run_id is null and lease_owner is null
  `;
}
