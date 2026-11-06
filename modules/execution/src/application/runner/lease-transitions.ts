import type { SQL } from "bun";
import { ACTIVE_RUN_STATUSES } from "../../domain/run-transitions";
import { leaseFence, sqlExpr, transitionRuns, type LeaseFence } from "../../sql/run-transitions";
import type { WorkerConfig } from "../worker-config";
import type { RunContext } from "./types";

/**
 * The worker's moves of a run it holds, one per intention, each under its
 * lease (`leaseFence`): an expired or taken-over lease writes nothing and
 * answers false (ADR 0001 S2d, inventory 0002 section 7). Shared by the
 * runner, the cancellation and the provider recovery.
 */

type Holder = Pick<RunContext, "id" | "organizationId" | "leaseGeneration">;
type Worker = Pick<WorkerConfig, "workerId">;

export const runKey = (context: Pick<RunContext, "id" | "organizationId">) => ({ organizationId: context.organizationId, id: context.id });
export const heldLease = (config: Worker, context: Holder): LeaseFence => leaseFence(config.workerId, context.leaseGeneration);

/** `not_started` → `creating`, with the model sent, just before `POST /v1/runs`. */
export async function markCreateIntent(db: SQL, config: Worker, context: Holder, model: string | null): Promise<boolean> {
  const rows = await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ["starting"], fromExternalState: ["not_started"], to: { externalState: "creating" } },
    set: { model, eventsComplete: false },
  });
  return rows.length > 0;
}

/** The first create answered: `starting` → `running`, `creating` → `streaming`, with the Hermes id. */
export async function confirmFirstCreate(db: SQL, config: Worker, context: Holder, hermesRunId: string, input: string): Promise<boolean> {
  const rows = await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ["starting"], fromExternalState: ["creating"], to: { status: "running", externalState: "streaming" } },
    set: { hermesRunId, startedAt: sqlExpr`coalesce(started_at, now())`, input, eventsComplete: false },
  });
  return rows.length > 0;
}

/** Durable intent of a provider fallback, before its create: the old id forgotten, the cursor reset. */
export async function markFallbackCreateIntent(db: SQL, config: Worker, context: Holder, model: string | null): Promise<boolean> {
  const rows = await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ACTIVE_RUN_STATUSES, to: { externalState: "creating" } },
    set: { hermesRunId: null, lastHermesSequence: 0, model, eventsComplete: false },
  });
  return rows.length > 0;
}

/** The fallback create answered: back to `running` / `streaming` on the new id. */
export async function confirmFallbackCreate(db: SQL, config: Worker, context: Holder, hermesRunId: string, model: string | null): Promise<boolean> {
  const rows = await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ACTIVE_RUN_STATUSES, fromExternalState: ["creating"], to: { status: "running", externalState: "streaming" } },
    set: { hermesRunId, model, eventsComplete: false },
    where: sqlExpr`hermes_run_id is null`,
  });
  return rows.length > 0;
}

/** `polling` → `streaming` on an announced replay of a known run, its stop never requested. */
export async function resumeAnnouncedReplay(db: SQL, config: Worker, context: Holder, hermesRunId: string): Promise<boolean> {
  const rows = await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ["running", "awaiting_approval"], fromExternalState: ["polling"], fromRemoteStopState: [null], to: { externalState: "streaming" } },
    set: { eventsComplete: false },
    where: sqlExpr`hermes_run_id = ${hermesRunId}`,
  });
  return rows.length > 0;
}

/** The stream is left for status reads (`polling`), with the local failure that caused it, if any. */
export async function switchToPolling(
  db: SQL,
  config: Worker,
  context: Holder,
  failure?: { code: string; message: string },
): Promise<void> {
  await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ACTIVE_RUN_STATUSES, to: { externalState: "polling" } },
    set: { eventsComplete: false, ...(failure ? { errorCode: failure.code, errorMessage: failure.message } : {}) },
  });
}

/** The stop is durable before `POST /stop`: `stopping` + `requested`. */
export async function requestRemoteStop(db: SQL, config: Worker, context: Holder): Promise<boolean> {
  const rows = await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ACTIVE_RUN_STATUSES, to: { externalState: "stopping", remoteStopState: "requested" } },
  });
  return rows.length > 0;
}

/** Hermes confirmed the stop: its outcome is now read by `polling`. */
export async function confirmRemoteStop(db: SQL, config: Worker, context: Holder): Promise<boolean> {
  const rows = await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ACTIVE_RUN_STATUSES, to: { externalState: "polling", remoteStopState: "confirmed" } },
  });
  return rows.length > 0;
}

/** `POST /stop` failed after it may have been received. */
export async function markRemoteStopAmbiguous(db: SQL, config: Worker, context: Holder): Promise<void> {
  await transitionRuns(db, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ACTIVE_RUN_STATUSES, to: { remoteStopState: "ambiguous" } },
  });
}

/** A forwarded gate decision confirmed: `awaiting_approval` → `running`. */
export async function resumeAfterApproval(tx: SQL, config: Worker, context: Holder): Promise<void> {
  await transitionRuns(tx, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ["awaiting_approval"], to: { status: "running" } },
  });
}

/**
 * Resume after a lost lease: a gate still open keeps the run in
 * `awaiting_approval` (`running` hid the gate from the API and the
 * heartbeat); `polling` stays, any other external state streams again. No
 * effect outside `starting`: a run already reattached keeps its state.
 */
export async function settleResumedRunStatus(db: SQL, config: Worker, context: Holder): Promise<void> {
  const openGate = sqlExpr`exists (
    select 1 from approval_requests gate
     where gate.organization_id = runs.organization_id and gate.run_id = runs.id
       and gate.status in ('pending','approved','denied')
       and gate.forward_state in ('pending','ready','sending')
  )`;
  const resume = (status: "awaiting_approval" | "running", where: typeof openGate) => (tx: SQL) => transitionRuns(tx, {
    target: runKey(context), fence: heldLease(config, context),
    transition: { from: ["starting"], to: { status, externalState: { map: { creating: "streaming", streaming: "streaming" } } } },
    set: { eventsComplete: false },
    where,
  });
  await db.begin(async (tx) => {
    const gated = await resume("awaiting_approval", openGate)(tx as unknown as SQL);
    if (gated.length === 0) await resume("running", sqlExpr`not ${openGate}`)(tx as unknown as SQL);
  });
}
