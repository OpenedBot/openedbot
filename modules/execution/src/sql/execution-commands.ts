import type { SQL } from "bun";
import type { TransactionDb } from "@openedbot/platform-db";

/**
 * `execution_commands` (0176, ADR 0001 S3): the durable mutations of
 * execution the API records and the worker executes. Every write of the worker
 * carries the lease fence (owner, generation, unexpired), so a worker whose
 * lease lapsed writes nothing once another one claimed the command.
 */

export type ExecutionCommandKind = "thread.compact";
export type ExecutionCommandStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ExecutionCommandRow = {
  id: string;
  organizationId: string;
  kind: ExecutionCommandKind;
  threadId: string;
  runtimeId: string;
  requestedByUserId: string | null;
  idempotencyKey: string | null;
  status: ExecutionCommandStatus;
  attempts: number;
  cancelRequestedAt: Date | null;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: Date | null;
  /** What earlier attempts already wrote (see `recordCommandProgressTx`). */
  progress: Record<string, unknown> | null;
  /** The last summary run created on the host (see `recordCommandHermesRun`). */
  hermesRun: { id: string; profile: string | null } | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

type RawCommand = {
  id: string; organization_id: string; kind: ExecutionCommandKind; thread_id: string; runtime_id: string;
  requested_by_user_id: string | null; idempotency_key: string | null; status: ExecutionCommandStatus;
  attempts: number; cancel_requested_at: Date | null; lease_owner: string | null;
  lease_generation: number | string; lease_expires_at: Date | null; progress: Record<string, unknown> | null;
  hermes_run: { id: string; profile: string | null } | null;
  result: Record<string, unknown> | null;
  error_code: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
};

function commandRow(raw: RawCommand | undefined): ExecutionCommandRow | null {
  if (!raw) return null;
  return {
    id: raw.id,
    organizationId: raw.organization_id,
    kind: raw.kind,
    threadId: raw.thread_id,
    runtimeId: raw.runtime_id,
    requestedByUserId: raw.requested_by_user_id,
    idempotencyKey: raw.idempotency_key,
    status: raw.status,
    attempts: Number(raw.attempts),
    cancelRequestedAt: raw.cancel_requested_at,
    leaseOwner: raw.lease_owner,
    leaseGeneration: Number(raw.lease_generation),
    leaseExpiresAt: raw.lease_expires_at,
    progress: raw.progress,
    hermesRun: raw.hermes_run,
    result: raw.result,
    errorCode: raw.error_code,
    createdAt: raw.created_at,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
  };
}

/** The fence of a claimed command, as the claim returned it. */
export type CommandLease = Pick<ExecutionCommandRow, "id" | "leaseOwner" | "leaseGeneration">;

/** Inserted, or null when an active command of the same kind already holds the thread (unique index). */
export async function insertExecutionCommandTx(tx: TransactionDb, input: {
  organizationId: string;
  kind: ExecutionCommandKind;
  threadId: string;
  runtimeId: string;
  requestedByUserId: string;
  idempotencyKey: string | null;
}): Promise<ExecutionCommandRow | null> {
  const rows = await tx<RawCommand[]>`
    insert into execution_commands (organization_id, kind, thread_id, runtime_id, requested_by_user_id, idempotency_key)
    values (${input.organizationId}, ${input.kind}, ${input.threadId}, ${input.runtimeId},
            ${input.requestedByUserId}, ${input.idempotencyKey})
    on conflict (organization_id, kind, thread_id) where status in ('queued', 'running') do nothing
    returning *
  `;
  return commandRow(rows[0]);
}

export async function readExecutionCommandTx(tx: TransactionDb, organizationId: string, id: string): Promise<ExecutionCommandRow | null> {
  const rows = await tx<RawCommand[]>`
    select * from execution_commands where organization_id = ${organizationId} and id = ${id}
  `;
  return commandRow(rows[0]);
}

export async function readCommandByKeyTx(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  kind: ExecutionCommandKind,
  key: string,
): Promise<ExecutionCommandRow | null> {
  const rows = await tx<RawCommand[]>`
    select * from execution_commands
     where organization_id = ${organizationId} and requested_by_user_id = ${userId}
       and kind = ${kind} and idempotency_key = ${key}
  `;
  return commandRow(rows[0]);
}

export async function readActiveCommandTx(
  tx: TransactionDb,
  organizationId: string,
  kind: ExecutionCommandKind,
  threadId: string,
): Promise<ExecutionCommandRow | null> {
  const rows = await tx<RawCommand[]>`
    select * from execution_commands
     where organization_id = ${organizationId} and kind = ${kind} and thread_id = ${threadId}
       and status in ('queued', 'running')
  `;
  return commandRow(rows[0]);
}

/**
 * Asks the active command to stop. A queued one that never started is
 * cancelled at once (nothing runs anywhere). A running one keeps its lease and
 * is told by the next heartbeat; one handed back by a stopping worker stays
 * queued, so the next worker stops its summary run on the host before the
 * thread is free. Null when no command is active.
 */
export async function requestCommandCancelTx(
  tx: TransactionDb,
  organizationId: string,
  kind: ExecutionCommandKind,
  threadId: string,
): Promise<ExecutionCommandRow | null> {
  const rows = await tx<RawCommand[]>`
    update execution_commands
       set cancel_requested_at = coalesce(cancel_requested_at, now()),
           status = case when status = 'queued' and started_at is null then 'cancelled' else status end,
           error_code = case when status = 'queued' and started_at is null then 'COMMAND_CANCELLED' else error_code end,
           finished_at = case when status = 'queued' and started_at is null then now() else finished_at end,
           updated_at = now()
     where organization_id = ${organizationId} and kind = ${kind} and thread_id = ${threadId}
       and status in ('queued', 'running')
    returning *
  `;
  return commandRow(rows[0]);
}

/**
 * A command no worker ever started is withdrawn, so a worker back much later
 * does not run it unasked. One handed back by a stopping worker is kept.
 */
export async function withdrawQueuedCommandTx(tx: TransactionDb, organizationId: string, id: string): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    update execution_commands
       set status = 'cancelled', error_code = 'COMMAND_NOT_STARTED', finished_at = now(), updated_at = now()
     where organization_id = ${organizationId} and id = ${id} and status = 'queued' and started_at is null
    returning id
  `;
  return rows.length > 0;
}

/**
 * Claims the oldest queued command, or a running one whose lease expired (its
 * worker died). Each claim counts an attempt; a command whose attempts are
 * spent, or never started and queued longer than `staleSeconds`, is failed in the same
 * transaction instead of being run (succeeded when its last attempt recorded
 * progress before dying); one that left a summary run on the host is
 * claimed again, so that a worker stops that run before settling it.
 */
export async function claimExecutionCommand(
  db: SQL,
  input: { workerId: string; leaseSeconds: number; maxAttempts: number; staleSeconds: number },
): Promise<ExecutionCommandRow | null> {
  return db.begin(async (tx) => {
    // The last attempt wrote its summary (and progress) before dying: that work is the result.
    await tx`
      update execution_commands
         set status = 'succeeded', result = progress, finished_at = now(), lease_owner = null, lease_expires_at = null,
             updated_at = now()
       where status = 'running' and lease_expires_at < now() and attempts >= ${input.maxAttempts}
         and jsonb_typeof(progress -> 'compactedThroughSequence') = 'number' and cancel_requested_at is null
         and hermes_run is null
    `;
    await tx`
      update execution_commands
         -- An accepted cancellation still settles as one.
         set status = case when cancel_requested_at is not null then 'cancelled' else 'failed' end,
             error_code = case when cancel_requested_at is not null then 'COMMAND_CANCELLED'
                               when attempts >= ${input.maxAttempts} then 'COMMAND_ATTEMPTS_EXHAUSTED' else 'COMMAND_EXPIRED' end,
             finished_at = now(), lease_owner = null, lease_expires_at = null, updated_at = now()
       where (status = 'running' and lease_expires_at < now() and attempts >= ${input.maxAttempts}
              -- A summary run left on the host gets two more claims, to stop it.
              and (hermes_run is null or attempts >= ${input.maxAttempts} + 2))
          or (status = 'queued' and started_at is null and created_at < now() - (${input.staleSeconds} * interval '1 second'))
    `;
    const rows = await tx<RawCommand[]>`
      with candidate as (
        select id as candidate_id from execution_commands
         where status = 'queued' or (status = 'running' and lease_expires_at < now())
         order by created_at, id
         for update skip locked
         limit 1
      )
      update execution_commands command
         set status = 'running', lease_owner = ${input.workerId}, lease_generation = command.lease_generation + 1,
             lease_expires_at = now() + (${input.leaseSeconds} * interval '1 second'),
             attempts = command.attempts + 1, started_at = coalesce(command.started_at, now()), updated_at = now()
        from candidate
       where command.id = candidate.candidate_id
      returning command.*
    `;
    return commandRow(rows[0]);
  });
}

const FENCE = (lease: CommandLease) => [lease.id, lease.leaseOwner, lease.leaseGeneration] as const;

/**
 * The heartbeat: extends an unexpired lease and reads back a cancellation
 * request. Null once the lease is lost (expired, taken over, or the command
 * left `running`, the thread deleted with it).
 */
export async function renewCommandLease(
  db: SQL,
  lease: CommandLease,
  leaseSeconds: number,
): Promise<{ cancelRequested: boolean } | null> {
  const [id, owner, generation] = FENCE(lease);
  const rows = await db<Array<{ cancelRequested: boolean }>>`
    update execution_commands
       set lease_expires_at = now() + (${leaseSeconds} * interval '1 second'), updated_at = now()
     where id = ${id} and status = 'running' and lease_owner = ${owner}
       and lease_generation = ${generation} and lease_expires_at > now()
    returning cancel_requested_at is not null as "cancelRequested"
  `;
  return rows[0] ?? null;
}

/** Records, under the lease, the summary run the attempt just created on the host. */
export async function recordCommandHermesRun(
  db: SQL,
  lease: CommandLease,
  hermesRun: { id: string; profile: string | null },
): Promise<boolean> {
  const [id, owner, generation] = FENCE(lease);
  const rows = await db<Array<{ id: string }>>`
    update execution_commands set hermes_run = ${hermesRun}::jsonb, updated_at = now()
     where id = ${id} and status = 'running' and lease_owner = ${owner}
       and lease_generation = ${generation} and lease_expires_at > now()
    returning id
  `;
  return rows.length > 0;
}

/**
 * Records, under the lease, what the attempt is about to write in the same
 * transaction; the row stays locked until it commits. Null when the lease is
 * lost or a cancellation was asked: the caller writes nothing.
 */
export async function recordCommandProgressTx(
  tx: TransactionDb,
  lease: CommandLease,
  progress: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const [id, owner, generation] = FENCE(lease);
  const rows = await tx<Array<{ progress: Record<string, unknown> }>>`
    update execution_commands set progress = ${progress}::jsonb, updated_at = now()
     where id = ${id} and status = 'running' and lease_owner = ${owner}
       and lease_generation = ${generation} and lease_expires_at > now() and cancel_requested_at is null
    returning progress
  `;
  return rows[0]?.progress ?? null;
}

export type CommandOutcome =
  | { status: "succeeded"; result: Record<string, unknown> }
  | { status: "failed" | "cancelled"; errorCode: string };

/**
 * Settles the command under its lease; false when the lease was lost and
 * nothing was written. Once a cancellation was asked, only `cancelled` settles it.
 */
export async function finishExecutionCommand(db: SQL, lease: CommandLease, outcome: CommandOutcome): Promise<boolean> {
  const [id, owner, generation] = FENCE(lease);
  const result = outcome.status === "succeeded" ? outcome.result : null;
  const errorCode = outcome.status === "succeeded" ? null : outcome.errorCode;
  const rows = await db<Array<{ id: string }>>`
    update execution_commands
       set status = ${outcome.status}, result = ${result}::jsonb, error_code = ${errorCode},
           finished_at = now(), lease_owner = null, lease_expires_at = null, updated_at = now()
     where id = ${id} and status = 'running' and lease_owner = ${owner}
       and lease_generation = ${generation} and lease_expires_at > now()
       and (${outcome.status} = 'cancelled' or cancel_requested_at is null)
    returning id
  `;
  return rows.length > 0;
}

/**
 * A stopping worker hands the command back at once instead of letting its
 * lease run out; the claim it does not finish is not counted as an attempt.
 */
export async function releaseExecutionCommand(db: SQL, lease: CommandLease): Promise<boolean> {
  const [id, owner, generation] = FENCE(lease);
  const rows = await db<Array<{ id: string }>>`
    update execution_commands
       set status = 'queued', attempts = greatest(attempts - 1, 0), lease_owner = null, lease_expires_at = null,
           updated_at = now()
     where id = ${id} and status = 'running' and lease_owner = ${owner}
       and lease_generation = ${generation} and lease_expires_at > now()
    returning id
  `;
  return rows.length > 0;
}

/** Retention: settled commands older than `days` are deleted. */
export async function purgeSettledExecutionCommands(db: SQL, days: number): Promise<number> {
  const rows = await db<Array<{ id: string }>>`
    delete from execution_commands
     where finished_at is not null and finished_at < now() - (${days} * interval '1 day')
    returning id
  `;
  return rows.length;
}
