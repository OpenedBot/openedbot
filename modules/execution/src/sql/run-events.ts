import type { SQL } from "bun";
import { organizationEventEnvelope, type OrganizationEvent, type RunEventRecord } from "@openedbot/contracts-events";
import {
  RunEventSequenceConflictError,
  nextSequenceAfter,
  proposedSequenceConflict,
} from "../domain/run-event-sequence";

/**
 * The only writer of `run_events`:
 * no other file inserts or updates the table, computes `max(sequence)` on it
 * or takes the cursor lock (`tests/scripts/run-events-contract.ts`).
 *
 * In the caller's transaction, every append takes, in this order:
 *
 *  1. the row lock of each target run (`for no key update`, by organization
 *     then id). It serializes the writers of a run among themselves and with
 *     any `update runs`, without blocking the `for key share` that a foreign
 *     key check (a message, an approval, an event) takes on the same row;
 *  2. the cursor lock of each organization, in organization order, held until
 *     commit: identity cursors are then allocated in commit order, so the SSE
 *     poller never skips an uncommitted lower cursor;
 *  3. `max(sequence)` in a separate statement. Under READ COMMITTED it sees
 *     every event committed by the previous holder of these locks, which a
 *     computation inside the statement that waited for them did not (D2).
 *
 * A transaction must take a run's row lock before the cursor lock of its
 * organization: re-entering is free (both locks are already held), but
 * locking a further run after the cursor can deadlock against a writer that
 * holds that run and waits for the cursor.
 */

/** An event numbered here, after the run's last one. */
export type RunEventDraft = {
  organizationId: string;
  threadId: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  /** Defaults to the database clock at insertion. */
  occurredAt?: Date;
  /** The writer's lease (0092 fence): the insert is refused if the run was claimed again since. */
  leaseGeneration?: number;
};

/** An event the worker's stream has already numbered (and published before the commit). */
export type NumberedRunEvent = {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
};

export type NumberedRunEventTarget = {
  organizationId: string;
  threadId: string;
  runId: string;
  leaseGeneration: number;
};

type InsertedRow = Pick<RunEventRecord, "cursor" | "botId" | "turnId" | "sessionKey" | "leaseGeneration"> & {
  occurredAt: Date | string;
};

/** Run ids by organization, both sorted: the lock order of every append. */
function byOrganization(targets: ReadonlyArray<{ organizationId: string; runId: string }>): Array<[string, string[]]> {
  const runs = new Map<string, Set<string>>();
  for (const target of targets) {
    const ids = runs.get(target.organizationId) ?? new Set<string>();
    ids.add(target.runId);
    runs.set(target.organizationId, ids);
  }
  return [...runs]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([organizationId, ids]) => [organizationId, [...ids].sort()]);
}

/**
 * Steps 1 and 2: the run rows, then the cursors. Re-entrant. A writer that
 * holds a run and must take further locks before its first append (the
 * worker's `persistEvents`: workflow, then gates) calls it first, so that the
 * cursor keeps its place in that writer's lock order.
 */
export async function lockRunEventsTx(
  tx: SQL,
  targets: ReadonlyArray<{ organizationId: string; runId: string }>,
): Promise<Array<[string, string[]]>> {
  const organizations = byOrganization(targets);
  for (const [organizationId, runIds] of organizations) {
    await tx`
      select id from runs
       where organization_id = ${organizationId} and id in ${tx(runIds)}
       order by id
       for no key update
    `;
  }
  for (const [organizationId] of organizations) {
    await tx`select pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('openedbot-run-events-cursor'))`;
  }
  return organizations;
}

/** Steps 1 to 3: the locks, then the next free sequence of each run, keyed `organization:run`. */
async function lockAndReadNextTx(
  tx: SQL,
  targets: ReadonlyArray<{ organizationId: string; runId: string }>,
): Promise<Map<string, number>> {
  const organizations = await lockRunEventsTx(tx, targets);
  const next = new Map<string, number>();
  for (const [organizationId, runIds] of organizations) {
    const rows = await tx<Array<{ runId: string; last: number | string | null }>>`
      select run_id as "runId", max(sequence) as last from run_events
       where organization_id = ${organizationId} and run_id in ${tx(runIds)}
       group by run_id
    `;
    const last = new Map(rows.map((row) => [row.runId, row.last]));
    for (const runId of runIds) next.set(`${organizationId}:${runId}`, nextSequenceAfter(last.get(runId)));
  }
  return next;
}

async function insertTx(
  tx: SQL,
  event: Omit<RunEventDraft, "leaseGeneration"> & { sequence: number; leaseGeneration: number | null },
): Promise<OrganizationEvent> {
  // A null lease generation lets the 0092 trigger stamp the run's own.
  const rows = await tx<InsertedRow[]>`
    insert into run_events (organization_id, thread_id, run_id, sequence, type, payload, occurred_at, lease_generation)
    values (${event.organizationId}, ${event.threadId}, ${event.runId}, ${event.sequence}, ${event.type},
            ${event.payload}, coalesce(${event.occurredAt ?? null}::timestamptz, clock_timestamp()),
            ${event.leaseGeneration})
    returning cursor, bot_id as "botId", turn_id as "turnId", session_key as "sessionKey",
              lease_generation as "leaseGeneration", occurred_at as "occurredAt"
  `;
  const row = rows[0];
  if (!row) throw new Error(`run event ${event.runId}#${event.sequence} was not inserted`);
  return organizationEventEnvelope({
    ...row,
    organizationId: event.organizationId,
    threadId: event.threadId,
    runId: event.runId,
    sequence: event.sequence,
    type: event.type,
    payload: event.payload,
    occurredAt: event.occurredAt ?? row.occurredAt,
  });
}

/**
 * Appends events after each run's last one, in the given order (per run:
 * contiguous sequences). The batch may span runs and organizations: every run
 * row is locked before any cursor. Returns the committed envelopes, in the
 * order given.
 */
export async function appendRunEventsTx(tx: SQL, events: readonly RunEventDraft[]): Promise<OrganizationEvent[]> {
  if (events.length === 0) return [];
  const next = await lockAndReadNextTx(tx, events);
  const result: OrganizationEvent[] = [];
  for (const event of events) {
    const key = `${event.organizationId}:${event.runId}`;
    const sequence = next.get(key)!;
    next.set(key, sequence + 1);
    result.push(await insertTx(tx, { ...event, sequence, leaseGeneration: event.leaseGeneration ?? null }));
  }
  return result;
}

/**
 * Writes events the worker's stream numbered itself: its normalizer counts
 * from `readNextRunEventSequence` and publishes each delta before the commit,
 * so the number cannot change here. Under the same locks, the batch must fit
 * after the run's last event, strictly increasing (holes allowed); otherwise
 * `RunEventSequenceConflictError`, before anything is written.
 */
export async function appendNumberedRunEventsTx(
  tx: SQL,
  target: NumberedRunEventTarget,
  events: readonly NumberedRunEvent[],
): Promise<OrganizationEvent[]> {
  if (events.length === 0) return [];
  const next = (await lockAndReadNextTx(tx, [target])).get(`${target.organizationId}:${target.runId}`)!;
  const conflict = proposedSequenceConflict(next, events.map((event) => event.sequence));
  if (conflict) throw new RunEventSequenceConflictError(target.runId, conflict.proposed, conflict.next);
  const result: OrganizationEvent[] = [];
  for (const event of events) {
    result.push(await insertTx(tx, {
      organizationId: target.organizationId,
      threadId: target.threadId,
      runId: target.runId,
      leaseGeneration: target.leaseGeneration,
      ...event,
    }));
  }
  return result;
}

/**
 * The first sequence the worker's normalizer will propose for a run it holds
 * the lease of. Only a proposal: `appendNumberedRunEventsTx` checks it again
 * under the locks, at every write.
 */
export async function readNextRunEventSequence(db: SQL, organizationId: string, runId: string): Promise<number> {
  const rows = await db<Array<{ last: number | string | null }>>`
    select max(sequence) as last from run_events
     where organization_id = ${organizationId} and run_id = ${runId}
  `;
  return nextSequenceAfter(rows[0]?.last);
}
