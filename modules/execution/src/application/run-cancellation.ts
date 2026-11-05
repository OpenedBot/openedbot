import type { TransactionDb } from "@openedbot/platform-db";

const ACTIVE_RUN_STATUSES = ["queued", "starting", "running", "awaiting_approval", "relaying"] as const;

export type CancellationRun = {
  id: string;
  originRunId: string | null;
  botId: string | null;
  previousStatus: string;
  status: "cancelled" | "requested" | "unknown";
  workflowId: string | null;
};

type LockedRun = {
  id: string;
  originRunId: string | null;
  botId: string | null;
  status: string;
  workflowId: string | null;
  hermesRunId: string | null;
  externalState: string;
};

type CancellationReason = { code: string; message: string };

export async function requestThreadCancellationTx(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  reason: CancellationReason,
): Promise<CancellationRun[]> {
  const lockTargets = () => tx<LockedRun[]>`
      with primary_runs as (
        select id from runs
         where organization_id = ${organizationId} and thread_id = ${threadId}
           and status in ${tx(ACTIVE_RUN_STATUSES)}
      ), targets as (
        select id from primary_runs
        union
        select child.id from runs child
         where child.organization_id = ${organizationId}
           and child.origin_run_id in (
             select courier.id from runs courier
              where courier.organization_id = ${organizationId} and courier.id in (select id from primary_runs)
                and courier.status = 'relaying'
           )
           and child.status in ${tx(ACTIVE_RUN_STATUSES)}
      )
      select run.id, run.origin_run_id as "originRunId", run.bot_id as "botId", run.status,
             run.workflow_id as "workflowId", run.hermes_run_id as "hermesRunId",
             run.external_state as "externalState"
        from runs run join targets on targets.id = run.id
       order by (run.origin_run_id is null), run.id
       for update of run
    `;
  // A completion transaction may have inserted the continuation while this
  // transaction waited for the previous run. A second READ COMMITTED snapshot
  // closes that race before any workflow row is locked.
  const rows = mergeLockedRuns(await lockTargets(), await lockTargets());
  return applyCancellationTx(tx, organizationId, rows, reason);
}

export async function requestRunCancellationTx(
  tx: TransactionDb,
  organizationId: string,
  runId: string,
  reason: CancellationReason,
): Promise<CancellationRun[]> {
  const lockTargets = () => tx<LockedRun[]>`
      with requested as (
        select workflow_id from runs
         where organization_id = ${organizationId} and id = ${runId}
      ), primary_runs as (
        select id from runs
         where organization_id = ${organizationId}
           and (
             id = ${runId}
             or workflow_id = (select workflow_id from requested)
           )
           and status in ${tx(ACTIVE_RUN_STATUSES)}
      ), targets as (
        select id from primary_runs
        union
        select child.id from runs child
         where child.organization_id = ${organizationId}
           and child.origin_run_id in (
             select courier.id from runs courier
              where courier.organization_id = ${organizationId} and courier.id in (select id from primary_runs)
                and courier.status = 'relaying'
           )
           and child.status in ${tx(ACTIVE_RUN_STATUSES)}
      )
      select run.id, run.origin_run_id as "originRunId", run.bot_id as "botId", run.status,
             run.workflow_id as "workflowId", run.hermes_run_id as "hermesRunId",
             run.external_state as "externalState"
        from runs run join targets on targets.id = run.id
       order by (run.origin_run_id is null), run.id
       for update of run
    `;
  const rows = mergeLockedRuns(await lockTargets(), await lockTargets());
  return applyCancellationTx(tx, organizationId, rows, reason);
}

export async function requestWorkflowCancellationTx(
  tx: TransactionDb,
  organizationId: string,
  workflowId: string,
  reason: CancellationReason,
): Promise<CancellationRun[]> {
  const lockTargets = () => tx<LockedRun[]>`
      select id, origin_run_id as "originRunId", bot_id as "botId", status,
             workflow_id as "workflowId", hermes_run_id as "hermesRunId",
             external_state as "externalState"
        from runs where organization_id = ${organizationId} and workflow_id = ${workflowId}
          and status in ${tx(ACTIVE_RUN_STATUSES)}
       order by id for update
    `;
  const rows = mergeLockedRuns(await lockTargets(), await lockTargets());
  return applyCancellationTx(tx, organizationId, rows, reason);
}

export async function requestOrganizationCancellationTx(
  tx: TransactionDb,
  organizationId: string,
  reason: CancellationReason,
): Promise<CancellationRun[]> {
  const lockTargets = () => tx<LockedRun[]>`
      select id, origin_run_id as "originRunId", bot_id as "botId", status,
             workflow_id as "workflowId", hermes_run_id as "hermesRunId",
             external_state as "externalState"
        from runs where organization_id = ${organizationId}
          and status in ${tx(ACTIVE_RUN_STATUSES)}
       order by (origin_run_id is null), id for update
    `;
  const rows = mergeLockedRuns(await lockTargets(), await lockTargets());
  return applyCancellationTx(tx, organizationId, rows, reason);
}

function mergeLockedRuns(...sets: readonly LockedRun[][]): LockedRun[] {
  return [...new Map(sets.flat().map((row) => [row.id, row])).values()]
    .sort((left, right) => Number(left.originRunId === null) - Number(right.originRunId === null) || left.id.localeCompare(right.id));
}

async function applyCancellationTx(
  tx: TransactionDb,
  organizationId: string,
  rows: readonly LockedRun[],
  reason: CancellationReason,
): Promise<CancellationRun[]> {
  if (rows.length === 0) return [];
  const workflowIds = [...new Set(rows.map((row) => row.workflowId).filter((id): id is string => Boolean(id)))].sort();
  if (workflowIds.length > 0) await tx`
    select id from workflows where organization_id = ${organizationId} and id in ${tx(workflowIds)}
     order by id for update
  `;
  const sending = await tx<Array<{ runId: string }>>`
    select run_id as "runId" from approval_requests
     where organization_id = ${organizationId} and run_id in ${tx(rows.map((row) => row.id))}
       and forward_state = 'sending'
     order by run_id, gate_ordinal for update
  `;
  const sendingRunIds = new Set(sending.map((gate) => gate.runId));
  const result: CancellationRun[] = [];

  for (const row of rows) {
    const approvalInFlight = sendingRunIds.has(row.id);
    const safelyLocal = !approvalInFlight && (
      row.status === "relaying" || row.externalState === "not_started" || row.externalState === "settled"
    );
    const canStopById = !approvalInFlight && row.hermesRunId !== null && row.externalState !== "ambiguous";
    const status: CancellationRun["status"] = safelyLocal ? "cancelled" : canStopById ? "requested" : "unknown";

    if (status === "cancelled") {
      await tx`
        update runs set status = 'cancelled', external_state = 'settled', events_complete = true,
          error_code = ${reason.code}, error_message = ${reason.message}, ended_at = now(),
          lease_owner = null, lease_expires_at = null, next_attempt_at = null, updated_at = now()
         where organization_id = ${organizationId} and id = ${row.id}
      `;
    } else if (status === "requested") {
      await tx`
        update runs set external_state = 'stopping', remote_stop_state = 'requested',
          error_code = ${reason.code}, error_message = ${reason.message}, ended_at = null,
          next_attempt_at = case when status = 'queued' then now() else next_attempt_at end, updated_at = now()
         where organization_id = ${organizationId} and id = ${row.id}
      `;
    } else {
      await tx`
        update runs set status = 'unknown', external_state = 'ambiguous', events_complete = false,
          remote_stop_state = case when remote_stop_state is null then 'ambiguous' else remote_stop_state end,
          error_code = 'CANCEL_OUTCOME_UNKNOWN',
          error_message = 'L’annulation croise un effet Hermes dont l’issue ne peut pas être confirmée.',
          ended_at = null, lease_owner = null, lease_expires_at = null, next_attempt_at = null, updated_at = now()
         where organization_id = ${organizationId} and id = ${row.id}
      `;
    }
    result.push({
      id: row.id,
      originRunId: row.originRunId,
      botId: row.botId,
      previousStatus: row.status,
      status,
      workflowId: row.workflowId,
    });
  }

  await tx`
    update approval_requests set
      status = case when status = 'pending' then 'expired' else status end,
      forward_state = case when forward_state = 'sending' then 'ambiguous' else 'expired' end,
      resolved_at = coalesce(resolved_at, now()), forwarding_owner = null,
      forwarding_lease_expires_at = null
     where organization_id = ${organizationId} and run_id in ${tx(rows.map((row) => row.id))}
       and (status = 'pending' or forward_state in ('pending','ready','sending'))
  `;

  for (const workflowId of workflowIds) {
    const affected = result.filter((run) => run.workflowId === workflowId);
    if (affected.some((run) => run.status === "unknown")) {
      await tx`
        update workflows set status = 'unknown', error_code = 'CANCEL_OUTCOME_UNKNOWN',
          error_message = 'L’annulation croise un effet Hermes dont l’issue ne peut pas être confirmée.',
          recovery_state = ${{ needsReview: true, cancelRequested: true }}, ended_at = null, updated_at = now()
         where organization_id = ${organizationId} and id = ${workflowId}
           and status not in ('completed','failed','expired')
      `;
    } else if (affected.some((run) => run.status === "requested")) {
      await tx`
        update workflows set error_code = 'CANCEL_REQUESTED', error_message = ${reason.message},
          recovery_state = ${{ cancelRequested: true }}, ended_at = null, updated_at = now()
         where organization_id = ${organizationId} and id = ${workflowId}
           and status in ('queued','running','awaiting_approval','reconciling')
      `;
    } else {
      await tx`
        update workflows set status = 'cancelled', error_code = ${reason.code}, error_message = ${reason.message},
          recovery_state = ${{ cancelRequested: true }}, ended_at = now(), updated_at = now()
         where organization_id = ${organizationId} and id = ${workflowId}
           and status in ('queued','running','awaiting_approval','reconciling')
      `;
    }
  }
  return result;
}

export const MAINTENANCE_STEP_KINDS = ["memory", "compaction"] as const;

export function isMaintenanceStepKind(stepKind: string | null | undefined): boolean {
  return stepKind === "memory" || stepKind === "compaction";
}

/**
 * Annule localement une passe de maintenance (`memory`, `compaction`) pour
 * qu'un archivage ou une purge puisse continuer. Contrairement à
 * `requestRunCancellationTx`, l'issue est toujours `cancelled` : ces runs
 * n'ont pas à bloquer le cycle de vie du bot, même si Hermes n'a pas encore
 * confirmé l'arrêt.
 */
export async function cancelMaintenanceRunsTx(
  tx: TransactionDb,
  organizationId: string,
  runs: ReadonlyArray<{ id: string; threadId: string }>,
  reason: CancellationReason,
): Promise<void> {
  if (runs.length === 0) return;
  await tx`
    select pg_advisory_xact_lock(
      hashtext(${organizationId}),
      hashtext('openedbot-run-events-cursor')
    )
  `;
  for (const run of runs) {
    await tx`
      update runs set status = 'cancelled', external_state = 'settled', events_complete = true,
        error_code = ${reason.code}, error_message = ${reason.message}, ended_at = now(),
        lease_owner = null, lease_expires_at = null, next_attempt_at = null, updated_at = now()
       where organization_id = ${organizationId} and id = ${run.id}
    `;
    const sequenceRows = await tx<Array<{ next: number }>>`
      select coalesce(max(sequence), -1) + 1 as next from run_events
       where organization_id = ${organizationId} and run_id = ${run.id}
    `;
    await tx`
      insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at)
      values (
        ${organizationId}, ${run.threadId}, ${run.id}, ${Number(sequenceRows[0]?.next ?? 0)},
        'run.error',
        ${{ message: reason.message, errorCode: reason.code }},
        now()
      )
    `;
  }
}
