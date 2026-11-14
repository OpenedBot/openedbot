import type { SQL } from "bun";
import { HermesClient, HermesClientError, RelayDialError } from "@openedbot/hermes";
import { FOLDED_COMPLETION_KIND, mergeFollowupInputs } from "@openedbot/conversation/domain/followup";
import { captureSteeringReceiptTx, withRunReceiptJournal } from "./run-receipts";
import { recordRunCompletionKindTx } from "../sql/run-columns";
import { NOW, RELEASE_LEASE, transitionRuns } from "../sql/run-transitions";

export const RUN_STEER_POLL_MS = 250;

/**
 * Plafond de POST /steer pour UNE tentative (`run_steering_attempts.attempts`).
 * Il n'y a pas de plafond en base : au-delà, la ligne passe `expired` avec
 * `STEER_ATTEMPTS_EXHAUSTED` et n'est plus rejouée. Seul un POST prouvé non
 * transmis peut revenir en pending. Un sending expiré devient ambiguous,
 * car le handler Hermes ne déduplique pas la clé de tentative.
 */
export const MAX_RUN_STEER_ATTEMPTS = 3;

/**
 * Même plafond que `MAX_RUN_ATTEMPTS` (queue.ts). Import impossible : queue
 * importe déjà ce module. Un run `starting|running` dont le bail est mort ET
 * qui a épuisé ses relances ne reviendra pas ; son steer pending meurt avec lui.
 */
export const STEER_TARGET_POISON_ATTEMPTS = 5;

export type RunSteerContext = {
  id: string;
  organizationId: string;
  threadId: string;
  leaseGeneration: number;
};

export type RunSteerConfig = {
  workerId: string;
  leaseSeconds: number;
};

export type RunSteerForwardOutcome =
  | "none"
  | "confirmed"
  | "unsupported"
  | "retry"
  | "rejected"
  | "ambiguous";

type ClaimedSteer = {
  id: string;
  sourceRunId: string;
  /** Null pour le repli d'un DM simple, admis sans workflow. */
  sourceWorkflowId: string | null;
  text: string;
  forwardingEpoch: number;
};

type RunSteerAckOutcome = "none" | "confirmed" | "rejected";

type RunSteerAckContext = Pick<RunSteerContext, "id" | "organizationId">;

type AmbiguousSteerDetails = {
  errorCode: string;
  code: string;
  status: number | null;
  requestDelivery: HermesClientError["requestDelivery"];
  causeCode: string | null;
  message: string;
};

/** Lecture sans verrou : elle évite une sonde capabilities sur les runs sans follow-up. */
export async function hasPendingRunSteer(db: SQL, context: RunSteerContext): Promise<boolean> {
  const rows = await db<Array<{ pending: boolean }>>`
    select exists(
      select 1 from run_steering_attempts steer
       join runs target on target.organization_id = steer.organization_id and target.id = steer.target_run_id
       join runs source on source.organization_id = steer.organization_id and source.id = steer.source_run_id
       left join workflows workflow on workflow.organization_id = source.organization_id and workflow.id = source.workflow_id
       where steer.organization_id = ${context.organizationId} and steer.target_run_id = ${context.id}
         and steer.status = 'pending' and steer.available_at <= now()
         and target.status = 'running' and target.external_state = 'streaming'
         and target.remote_stop_state is null and target.hermes_run_id is not null
         and source.status = 'queued' and (source.workflow_id is null or workflow.status = 'queued')
    ) as pending
  `;
  return rows[0]?.pending === true;
}

/** Un vieux runtime laisse chaque workflow de repli dans sa file d'origine. */
export async function markPendingRunSteersUnsupported(db: SQL, context: RunSteerContext): Promise<void> {
  await withRunReceiptJournal(db, async (tx) => {
    await tx`select run.id from runs run where run.organization_id = ${context.organizationId}
      and (run.id = ${context.id} or run.id in (
        select source_run_id from run_steering_attempts where organization_id = ${context.organizationId}
          and target_run_id = ${context.id} and status = 'pending'))
      order by run.id for update`;
    const changed = await tx<Array<{ id: string }>>`
    update run_steering_attempts set status = 'unsupported', error_code = 'HERMES_RUN_STEER_UNSUPPORTED',
      forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
     where organization_id = ${context.organizationId} and target_run_id = ${context.id}
       and status = 'pending'
     returning id
  `;
    for (const row of changed) captureSteeringReceiptTx(tx, context.organizationId, row.id);
  });
}

/**
 * Livre exactement le plus ancien follow-up admissible. Les runs plus anciens
 * sans steer (pièce jointe, citation, salon...) restent des barrières FIFO :
 * une consigne plus récente ne peut jamais les dépasser.
 */
export async function forwardNextRunSteer(
  db: SQL,
  client: HermesClient,
  config: RunSteerConfig,
  context: RunSteerContext,
  hermesRunId: string,
  signal: AbortSignal,
): Promise<RunSteerForwardOutcome> {
  const claimed = await claimRunSteer(db, config, context);
  if (!claimed) return "none";
  let responseStatus: number;
  try {
    responseStatus = await client.steerRun(hermesRunId, {
      text: claimed.text,
      // Stable correlation key. Delivery safety comes from the durable state
      // and not_sent boundary; Hermes does not deduplicate this header.
      idempotencyKey: claimed.id,
      signal,
    });
  } catch (error) {
    const disposition = runSteerFailureDisposition(error);
    if (disposition === "retry") {
      await returnRunSteerToPending(db, config, context, claimed);
      return "retry";
    }
    if (disposition === "rejected") {
      await rejectRunSteer(db, config, context, claimed, error);
      return "rejected";
    }
    const details = ambiguousSteerDetails(error);
    await markRunSteerAmbiguous(db, config, context, claimed, details);
    logAmbiguousSteer(context, claimed, details);
    return "ambiguous";
  }
  return await confirmRunSteer(db, config, context, claimed, responseStatus) ? "confirmed" : "ambiguous";
}

/**
 * Applique l'ACK `run.steered` du flux Hermes. Cet événement est la source de
 * vérité : il peut confirmer une tentative dont le POST HTTP a fini ambigu.
 * La tentative la plus ancienne gagne, afin de conserver l'ordre FIFO des
 * messages reçus pendant le run actif.
 */
export async function reconcileRunSteerEvent(
  db: SQL,
  context: RunSteerAckContext,
  accepted: boolean,
): Promise<RunSteerAckOutcome> {
  return withRunReceiptJournal(db, async (tx) => {
    const candidates = await tx<Array<{
      id: string;
      sourceRunId: string;
      sourceWorkflowId: string | null;
    }>>`
      select steer.id, steer.source_run_id as "sourceRunId", source.workflow_id as "sourceWorkflowId"
        from run_steering_attempts steer
        join runs source on source.organization_id = steer.organization_id and source.id = steer.source_run_id
       where steer.organization_id = ${context.organizationId} and steer.target_run_id = ${context.id}
         and steer.status in ('sending', 'ambiguous')
       order by steer.created_at asc, steer.id asc
       limit 1
    `;
    const candidate = candidates[0];
    if (!candidate) return "none";

    // Ordre de verrous partagé avec confirmRunSteer : runs triés, workflow,
    // tentative. La relecture sous verrou protège l'ACK contre un recovery
    // concurrent et contre un repli déjà réclamé.
    const runs = await tx<Array<{ id: string; status: string }>>`
      select id, status from runs
       where organization_id = ${context.organizationId}
         and id in ${tx([context.id, candidate.sourceRunId].sort())}
       order by id for update
    `;
    const workflowQueued = await lockSourceWorkflowQueuedTx(tx, context.organizationId, candidate.sourceWorkflowId);
    const attempt = await tx<Array<{ status: string }>>`
      select status from run_steering_attempts
       where organization_id = ${context.organizationId} and id = ${candidate.id}
       for update
    `;
    if (attempt[0]?.status !== "sending" && attempt[0]?.status !== "ambiguous") return "none";
    if (
      runs.find((run) => run.id === candidate.sourceRunId)?.status !== "queued" ||
      !workflowQueued
    ) return "none";

    if (!accepted) {
      await tx`
        update run_steering_attempts set status = 'rejected', error_code = 'HERMES_STEER_REJECTED',
          forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
         where organization_id = ${context.organizationId} and id = ${candidate.id}
           and status in ('sending', 'ambiguous')
      `;
      captureSteeringReceiptTx(tx, context.organizationId, candidate.id);
      return "rejected";
    }

    await confirmRunSteerEffectTx(
      tx, context.organizationId, context.id, candidate.sourceRunId, candidate.sourceWorkflowId, candidate.id,
    );
    return "confirmed";
  }) as Promise<RunSteerAckOutcome>;
}

export function runSteerFailureDisposition(error: unknown): "retry" | "rejected" | "ambiguous" {
  if (!(error instanceof HermesClientError)) return "ambiguous";
  if (error.requestDelivery === "not_sent") return "retry";
  if (
    error.requestDelivery === "response_received" &&
    (error.status < 500 || error.status === 501)
  ) return "rejected";
  return "ambiguous";
}

function ambiguousSteerDetails(error: unknown): AmbiguousSteerDetails {
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  const causeCode = readCauseCode(cause);
  const message = error instanceof Error
    ? error.message
    : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);

  if (error instanceof HermesClientError) {
    return {
      errorCode: composeAmbiguousSteerCode(error.code, causeCode),
      code: error.code,
      status: error.status,
      requestDelivery: error.requestDelivery,
      causeCode,
      message: message.slice(0, 200),
    };
  }

  const name = error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name || "UNKNOWN"
    : "UNKNOWN";
  return {
    errorCode: composeAmbiguousSteerCode(name, null),
    code: name,
    status: null,
    requestDelivery: null,
    causeCode,
    message: message.slice(0, 200),
  };
}

function composeAmbiguousSteerCode(code: string, causeCode: string | null): string {
  return ["HERMES_STEER_OUTCOME_UNKNOWN", code, causeCode].filter(Boolean).join(":").slice(0, 120);
}

function readCauseCode(cause: unknown): string | null {
  if (cause instanceof RelayDialError && typeof cause.code === "string") return cause.code;
  if (cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string") {
    return (cause as { code: string }).code;
  }
  return null;
}

async function claimRunSteer(
  db: SQL,
  config: RunSteerConfig,
  context: RunSteerContext,
): Promise<ClaimedSteer | null> {
  return withRunReceiptJournal(db, async (tx) => {
    const target = await tx<Array<{ id: string }>>`
      select id from runs
       where organization_id = ${context.organizationId} and id = ${context.id}
         and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
         and status = 'running' and external_state = 'streaming' and remote_stop_state is null
    `;
    if (!target[0]) return null;
    const candidates = await tx<Array<{
      id: string;
      sourceRunId: string;
      sourceWorkflowId: string | null;
      text: string;
    }>>`
      select steer.id, steer.source_run_id as "sourceRunId", source.workflow_id as "sourceWorkflowId",
             steer.text
        from run_steering_attempts steer
        join runs source on source.organization_id = steer.organization_id and source.id = steer.source_run_id
        left join workflows workflow on workflow.organization_id = source.organization_id and workflow.id = source.workflow_id
       where steer.organization_id = ${context.organizationId} and steer.target_run_id = ${context.id}
         and steer.status = 'pending' and steer.available_at <= now()
         and steer.attempts < ${MAX_RUN_STEER_ATTEMPTS}
         and source.status = 'queued' and (source.workflow_id is null or workflow.status = 'queued')
         and not exists (
           select 1 from runs older
           left join workflows older_workflow
             on older_workflow.organization_id = older.organization_id and older_workflow.id = older.workflow_id
            where older.organization_id = source.organization_id and older.thread_id = source.thread_id
              and older.id <> source.id and older.status = 'queued'
              and (
                coalesce(older_workflow.created_at, older.created_at),
                coalesce(older_workflow.id, older.id), older.created_at, older.id
              ) < (
                coalesce(workflow.created_at, source.created_at),
                coalesce(workflow.id, source.id), source.created_at, source.id
              )
         )
       order by coalesce(workflow.created_at, source.created_at) asc, coalesce(workflow.id, source.id) asc,
                source.created_at asc, source.id asc
       limit 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;
    const runs = await tx<Array<{ id: string; status: string; canSteer: boolean }>>`
      select id, status,
             (lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
               and status = 'running' and external_state = 'streaming' and remote_stop_state is null) as "canSteer"
        from runs
       where organization_id = ${context.organizationId} and id in ${tx([context.id, candidate.sourceRunId].sort())}
       order by id for update
    `;
    const workflowQueued = await lockSourceWorkflowQueuedTx(tx, context.organizationId, candidate.sourceWorkflowId);
    const attempts = await tx<Array<{ status: string }>>`
      select status from run_steering_attempts
       where organization_id = ${context.organizationId} and id = ${candidate.id}
       for update
    `;
    if (runs.find((run) => run.id === context.id)?.canSteer !== true) return null;
    if (
      runs.find((run) => run.id === candidate.sourceRunId)?.status !== "queued" ||
      !workflowQueued || attempts[0]?.status !== "pending"
    ) {
      const expired = await tx<Array<{ id: string }>>`
        update run_steering_attempts set status = 'expired', error_code = 'STEER_FALLBACK_NOT_QUEUED',
          updated_at = now()
         where organization_id = ${context.organizationId} and id = ${candidate.id} and status = 'pending'
         returning id
      `;
      if (expired[0]) captureSteeringReceiptTx(tx, context.organizationId, candidate.id);
      return null;
    }
    const sent = await tx<Array<{ forwardingEpoch: string | number }>>`
      update run_steering_attempts set status = 'sending', attempts = attempts + 1,
        forwarding_owner = ${config.workerId}, forwarding_epoch = forwarding_epoch + 1,
        forwarding_lease_expires_at = now() + (${config.leaseSeconds} * interval '1 second'),
        updated_at = now()
       where organization_id = ${context.organizationId} and id = ${candidate.id} and status = 'pending'
       returning forwarding_epoch as "forwardingEpoch"
    `;
    if (!sent[0]) return null;
    captureSteeringReceiptTx(tx, context.organizationId, candidate.id);
    return { ...candidate, forwardingEpoch: Number(sent[0].forwardingEpoch) };
  }) as Promise<ClaimedSteer | null>;
}

async function confirmRunSteer(
  db: SQL,
  config: RunSteerConfig,
  context: RunSteerContext,
  steer: ClaimedSteer,
  responseStatus: number,
): Promise<boolean> {
  return withRunReceiptJournal(db, async (tx) => {
    const runs = await tx<Array<{
      id: string;
      status: string;
      remoteStopState: string | null;
      leaseOwner: string | null;
      leaseGeneration: string | number;
    }>>`
      select id, status, remote_stop_state as "remoteStopState", lease_owner as "leaseOwner",
             lease_generation as "leaseGeneration"
        from runs where organization_id = ${context.organizationId}
         and id in ${tx([context.id, steer.sourceRunId].sort())}
       order by id for update
    `;
    const workflowQueued = await lockSourceWorkflowQueuedTx(tx, context.organizationId, steer.sourceWorkflowId);
    const attempt = await tx<Array<{ status: string; forwardingOwner: string | null; forwardingEpoch: string | number }>>`
      select status, forwarding_owner as "forwardingOwner", forwarding_epoch as "forwardingEpoch"
        from run_steering_attempts
       where organization_id = ${context.organizationId} and id = ${steer.id}
       for update
    `;
    const target = runs.find((run) => run.id === context.id);
    const source = runs.find((run) => run.id === steer.sourceRunId);
    // The durable SSE ACK can win the race with the HTTP response. Its
    // confirmation already settled this source atomically.
    if (attempt[0]?.status === "confirmed" && source?.status === "cancelled") return true;
    const fenced = target?.status === "running" && target.remoteStopState === null &&
      target.leaseOwner === config.workerId && Number(target.leaseGeneration) === context.leaseGeneration &&
      source?.status === "queued" && workflowQueued &&
      attempt[0]?.status === "sending" && attempt[0].forwardingOwner === config.workerId &&
      Number(attempt[0].forwardingEpoch) === steer.forwardingEpoch;
    if (!fenced) {
      const conditions = [
        ["target_status", target?.status === "running", target?.status ?? null, "running"],
        ["lease_owner", target?.leaseOwner === config.workerId, target?.leaseOwner, config.workerId],
        ["lease_generation", Number(target?.leaseGeneration) === context.leaseGeneration,
          target ? Number(target.leaseGeneration) : null, context.leaseGeneration],
        ["source_status", source?.status === "queued", source?.status ?? null, "queued"],
        ["workflow_status", workflowQueued, workflowQueued ? "queued" : "not_queued", "queued"],
        ["attempt_status", attempt[0]?.status === "sending", attempt[0]?.status ?? null, "sending"],
        ["attempt_owner", attempt[0]?.forwardingOwner === config.workerId,
          attempt[0]?.forwardingOwner, config.workerId],
        ["attempt_epoch", Number(attempt[0]?.forwardingEpoch) === steer.forwardingEpoch,
          attempt[0] ? Number(attempt[0].forwardingEpoch) : null, steer.forwardingEpoch],
      ] as const;
      logSteerFenceFailure(context, steer, Object.fromEntries(
        conditions.filter(([, passed]) => !passed).map(([name, , actual, expected]) => [name, { actual, expected }]),
      ));
      await markRunSteerAmbiguousTx(tx, context, steer);
      return false;
    }
    await confirmRunSteerEffectTx(
      tx, context.organizationId, context.id, steer.sourceRunId, steer.sourceWorkflowId, steer.id, responseStatus,
    );
    return true;
  }) as Promise<boolean>;
}

async function confirmRunSteerEffectTx(
  tx: SQL,
  organizationId: string,
  targetRunId: string,
  sourceRunId: string,
  sourceWorkflowId: string | null,
  attemptId: string,
  responseStatus: number | null = null,
): Promise<void> {
  await tx`
    update run_steering_attempts set status = 'confirmed', delivered_at = now(), response_status = ${responseStatus},
      error_code = null, forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
   where organization_id = ${organizationId} and id = ${attemptId}
  `;
  // The fallback never left the queue: no lease to hold.
  await transitionRuns(tx, {
    target: { organizationId, id: sourceRunId }, fence: "unleased", transition: { from: ["queued"], to: { status: "cancelled", externalState: "settled" } },
    set: { eventsComplete: true, completionKind: "steered_into_active", errorCode: null, errorMessage: null, endedAt: NOW, ...RELEASE_LEASE, nextAttemptAt: null },
  });
  if (sourceWorkflowId) await tx`
    update workflows set status = 'completed', final_output = null,
      recovery_state = ${{ steeredIntoRunId: targetRunId, steeringAttemptId: attemptId }},
      error_code = null, error_message = null, ended_at = now(), updated_at = now()
     where organization_id = ${organizationId} and id = ${sourceWorkflowId} and status = 'queued'
  `;
  captureSteeringReceiptTx(tx, organizationId, attemptId);
}

/**
 * Verrouille le workflow du repli, entre les runs et la tentative (ordre de
 * verrous partagé). Un repli de DM simple n'a pas de workflow : seul le
 * statut de son run fait foi.
 */
async function lockSourceWorkflowQueuedTx(
  tx: SQL,
  organizationId: string,
  workflowId: string | null,
): Promise<boolean> {
  if (!workflowId) return true;
  const rows = await tx<Array<{ status: string }>>`
    select status from workflows
     where organization_id = ${organizationId} and id = ${workflowId}
     for update
  `;
  return rows[0]?.status === "queued";
}

async function returnRunSteerToPending(
  db: SQL,
  config: RunSteerConfig,
  context: RunSteerContext,
  steer: ClaimedSteer,
): Promise<void> {
  await withRunReceiptJournal(db, async (tx) => {
    await lockSteerParentsTx(tx, [{ organizationId: context.organizationId, targetRunId: context.id, sourceRunId: steer.sourceRunId }]);
    const changed = await tx<Array<{ id: string }>>`
    update run_steering_attempts set
      status = case when attempts >= ${MAX_RUN_STEER_ATTEMPTS} then 'expired' else 'pending' end,
      available_at = case when attempts >= ${MAX_RUN_STEER_ATTEMPTS} then available_at
        else now() + interval '1 second' end,
      error_code = case when attempts >= ${MAX_RUN_STEER_ATTEMPTS} then 'STEER_ATTEMPTS_EXHAUSTED'
        else 'HERMES_STEER_NOT_SENT' end,
      forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
     where organization_id = ${context.organizationId} and id = ${steer.id}
       and status = 'sending' and forwarding_owner = ${config.workerId}
       and forwarding_epoch = ${steer.forwardingEpoch}
     returning id
  `;
    if (changed[0]) captureSteeringReceiptTx(tx, context.organizationId, steer.id);
  });
}

async function rejectRunSteer(
  db: SQL,
  config: RunSteerConfig,
  context: RunSteerContext,
  steer: ClaimedSteer,
  error: unknown,
): Promise<void> {
  const status = error instanceof HermesClientError ? error.status : null;
  const code = error instanceof HermesClientError ? error.code : "HERMES_STEER_REJECTED";
  await withRunReceiptJournal(db, async (tx) => {
    await lockSteerParentsTx(tx, [{ organizationId: context.organizationId, targetRunId: context.id, sourceRunId: steer.sourceRunId }]);
    const changed = await tx<Array<{ id: string }>>`
    update run_steering_attempts set status = 'rejected', response_status = ${status}, error_code = ${code},
      forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
     where organization_id = ${context.organizationId} and id = ${steer.id}
       and status = 'sending' and forwarding_owner = ${config.workerId}
       and forwarding_epoch = ${steer.forwardingEpoch}
     returning id
  `;
    if (changed[0]) captureSteeringReceiptTx(tx, context.organizationId, steer.id);
  });
}

async function markRunSteerAmbiguous(
  db: SQL,
  config: RunSteerConfig,
  context: RunSteerContext,
  steer: ClaimedSteer,
  details?: AmbiguousSteerDetails,
): Promise<void> {
  await withRunReceiptJournal(db, async (tx) => {
    await tx`
      select id from runs where organization_id = ${context.organizationId}
       and id in ${tx([context.id, steer.sourceRunId].sort())} order by id for update
    `;
    await lockSourceWorkflowQueuedTx(tx, context.organizationId, steer.sourceWorkflowId);
    const attempt = await tx<Array<{ id: string }>>`
      select id from run_steering_attempts
       where organization_id = ${context.organizationId} and id = ${steer.id}
         and status = 'sending' and forwarding_owner = ${config.workerId}
         and forwarding_epoch = ${steer.forwardingEpoch}
       for update
    `;
    if (!attempt[0]) return;
    await markRunSteerAmbiguousTx(tx, context, steer, details);
  });
}

async function markRunSteerAmbiguousTx(
  tx: SQL,
  context: RunSteerContext,
  steer: ClaimedSteer,
  details?: AmbiguousSteerDetails,
): Promise<void> {
  if (details) {
    const changed = await tx<Array<{ id: string }>>`
      update run_steering_attempts set status = 'ambiguous', response_status = ${details.status}, error_code = ${details.errorCode},
        forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
       where organization_id = ${context.organizationId} and id = ${steer.id}
         and status in ('sending','pending')
       returning id
    `;
    if (changed[0]) captureSteeringReceiptTx(tx, context.organizationId, steer.id);
    return;
  }
  const changed = await tx<Array<{ id: string }>>`
    update run_steering_attempts set status = 'ambiguous', error_code = 'HERMES_STEER_OUTCOME_UNKNOWN',
      forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
     where organization_id = ${context.organizationId} and id = ${steer.id}
       and status in ('sending','pending')
     returning id
  `;
  if (changed[0]) captureSteeringReceiptTx(tx, context.organizationId, steer.id);
}

function logAmbiguousSteer(
  context: RunSteerContext,
  steer: ClaimedSteer,
  details: AmbiguousSteerDetails,
): void {
  console.error(JSON.stringify({
    event: "worker.run_steer_ambiguous",
    runId: context.id,
    attemptId: steer.id,
    code: details.code,
    status: details.status,
    requestDelivery: details.requestDelivery,
    causeCode: details.causeCode,
    message: details.message,
  }));
}

function logSteerFenceFailure(
  context: RunSteerContext,
  steer: ClaimedSteer,
  failedConditions: Record<string, unknown>,
): void {
  console.info(JSON.stringify({
    event: "worker.run_steer_fence_failed",
    runId: context.id,
    organizationId: context.organizationId,
    sourceRunId: steer.sourceRunId,
    attemptId: steer.id,
    failedConditions,
  }));
}

async function lockSteerParentsTx(tx: SQL, rows: ReadonlyArray<{
  organizationId: string; targetRunId: string; sourceRunId: string;
}>): Promise<void> {
  const parents = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = parents.get(row.organizationId) ?? new Set<string>();
    ids.add(row.targetRunId); ids.add(row.sourceRunId);
    parents.set(row.organizationId, ids);
  }
  for (const [organizationId, ids] of [...parents].sort(([left], [right]) => left.localeCompare(right))) {
    await tx`select id from runs where organization_id = ${organizationId} and id in ${tx([...ids].sort())}
      order by id for update`;
  }
}

/**
 * Un `pending` reste en file tant que la cible est vivante, même sans
 * `hermes_run_id` (tour réclamé, création Hermes pas finie). Il meurt avec un
 * code stable quand la cible expire, échoue, ou que le lien runtime est mort
 * et que plus personne ne tient le bail. Le repli (DM sans workflow,
 * workflow autonome, ou salon) redevient une FIFO ordinaire.
 */
async function expirePendingRunSteersTx(tx: SQL, context?: RunSteerAckContext): Promise<void> {
  const relations = tx`runs target
     left join workflows target_workflow
       on target_workflow.organization_id = target.organization_id and target_workflow.id = target.workflow_id
     join runs source
       on source.organization_id = target.organization_id
     left join workflows source_workflow
       on source_workflow.organization_id = source.organization_id and source_workflow.id = source.workflow_id
  `;
  const eligible = tx`target.organization_id = steer.organization_id and target.id = steer.target_run_id
       and source.organization_id = steer.organization_id and source.id = steer.source_run_id
       and steer.status = 'pending'
       ${context ? tx`and steer.organization_id = ${context.organizationId} and steer.target_run_id = ${context.id}` : tx``}
       and (
         steer.attempts >= ${MAX_RUN_STEER_ATTEMPTS}
         or source.status <> 'queued'
         or (source.workflow_id is not null and source_workflow.status is distinct from 'queued')
         or target.remote_stop_state is not null
         or target.status in ('completed','failed','cancelled','unknown','relaying')
         or (
           target.status in ('starting','running','awaiting_approval')
           and target.lease_expires_at < now()
           and target.attempts >= ${STEER_TARGET_POISON_ATTEMPTS}
         )
         or (
           target.status in ('queued','starting','running','awaiting_approval')
           and coalesce(target_workflow.deadline_at, target.deadline_at) <= now()
         )
         or target.error_code in ('RUNTIME_DISCONNECTED', 'WORKFLOW_DEADLINE_EXCEEDED')
       )
  `;
  const candidates = await tx<Array<{ id: string; organizationId: string; targetRunId: string; sourceRunId: string }>>`
    select steer.id, steer.organization_id as "organizationId", steer.target_run_id as "targetRunId",
           steer.source_run_id as "sourceRunId"
      from run_steering_attempts steer cross join ${relations}
     where ${eligible} order by steer.organization_id, steer.id limit 50
  `;
  if (!candidates.length) return;
  await lockSteerParentsTx(tx, candidates);
  const changed = await tx<Array<{ id: string; organizationId: string }>>`
    update run_steering_attempts steer set status = 'expired',
      error_code = case
        when steer.attempts >= ${MAX_RUN_STEER_ATTEMPTS} then 'STEER_ATTEMPTS_EXHAUSTED'
        when target.error_code = 'WORKFLOW_DEADLINE_EXCEEDED'
          or (target.status in ('queued','starting','running','awaiting_approval')
            and coalesce(target_workflow.deadline_at, target.deadline_at) <= now()) then 'STEER_TARGET_EXPIRED'
        when target.error_code = 'RUNTIME_DISCONNECTED' then 'STEER_RUNTIME_DISCONNECTED'
        when source.status <> 'queued'
          or (source.workflow_id is not null and source_workflow.status is distinct from 'queued') then 'STEER_FALLBACK_NOT_QUEUED'
        else 'STEER_TARGET_INACTIVE'
      end,
      forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
     from ${relations}
     where ${eligible} and steer.id in ${tx(candidates.map((row) => row.id))}
     returning steer.id, steer.organization_id as "organizationId"
  `;
  for (const row of changed) captureSteeringReceiptTx(tx, row.organizationId, row.id);
}

/**
 * Répare les limites de crash avant toute nouvelle réclamation de run.
 * `sending` expiré devient ambigu (jamais rejoué); `pending` dont la cible est
 * définitivement inactive libère simplement son repli FIFO.
 */
export async function recoverRunSteersBeforeClaim(tx: SQL): Promise<void> {
  await expireTerminalRunSteersTx(tx);
  const stale = await tx<Array<{
    organizationId: string;
    sourceRunId: string;
    sourceWorkflowId: string | null;
    targetRunId: string;
    attemptId: string;
  }>>`
    select steer.organization_id as "organizationId", steer.source_run_id as "sourceRunId",
      source.workflow_id as "sourceWorkflowId", steer.target_run_id as "targetRunId", steer.id as "attemptId"
     from run_steering_attempts steer
     join runs source on source.organization_id = steer.organization_id and source.id = steer.source_run_id
     where steer.status = 'sending' and steer.forwarding_lease_expires_at <= now()
     order by steer.organization_id, steer.id
     limit 50
  `;
  await lockSteerParentsTx(tx, stale);
  for (const row of stale) {
    // Même ordre de verrous que claim/confirm et que les routes de recovery :
    // runs triés, workflow, tentative. Un reaper ne peut donc pas tenir
    // l'outbox en attendant le run qu'un ACK tient déjà.
    await tx`
      select id from runs where organization_id = ${row.organizationId}
       and id in ${tx([row.targetRunId, row.sourceRunId].sort())}
       order by id for update
    `;
    await lockSourceWorkflowQueuedTx(tx, row.organizationId, row.sourceWorkflowId);
    const attempts = await tx<Array<{ id: string }>>`
      select id from run_steering_attempts
       where organization_id = ${row.organizationId} and id = ${row.attemptId}
         and status = 'sending' and forwarding_lease_expires_at <= now()
       for update
    `;
    if (!attempts[0]) continue;
    await tx`
      update run_steering_attempts set status = 'ambiguous',
        error_code = 'HERMES_STEER_OUTCOME_UNKNOWN', forwarding_owner = null,
        forwarding_lease_expires_at = null, updated_at = now()
       where organization_id = ${row.organizationId} and id = ${row.attemptId}
         and status = 'sending'
    `;
    captureSteeringReceiptTx(tx, row.organizationId, row.attemptId);
  }
}

/** Un ACK persistant n'empêche jamais le repli d'être repris par la FIFO. */
export async function expireUnacknowledgedRunSteers(
  db: SQL,
  context: RunSteerAckContext,
): Promise<void> {
  await withRunReceiptJournal(db, (tx) => expireTerminalRunSteersTx(tx, context));
}

async function expireTerminalRunSteersTx(
  tx: SQL,
  context?: RunSteerAckContext,
): Promise<void> {
  const rows = await tx<Array<{
    organizationId: string;
    sourceRunId: string;
    sourceWorkflowId: string | null;
    targetRunId: string;
    attemptId: string;
  }>>`
    select steer.organization_id as "organizationId", steer.source_run_id as "sourceRunId",
      source.workflow_id as "sourceWorkflowId", steer.target_run_id as "targetRunId", steer.id as "attemptId"
     from run_steering_attempts steer
     join runs target on target.organization_id = steer.organization_id and target.id = steer.target_run_id
     join runs source on source.organization_id = steer.organization_id and source.id = steer.source_run_id
    where steer.status in ('sending', 'ambiguous')
      and target.status in ('completed', 'failed', 'cancelled')
      ${context ? tx`and steer.organization_id = ${context.organizationId} and steer.target_run_id = ${context.id}` : tx``}
    order by steer.organization_id, steer.created_at, steer.id
    limit 50
  `;
  await lockSteerParentsTx(tx, rows);
  for (const row of rows) {
    // Même ordre de verrous que l'ACK : runs triés, workflow, tentative.
    await tx`
      select id from runs where organization_id = ${row.organizationId}
       and id in ${tx([row.targetRunId, row.sourceRunId].sort())}
       order by id for update
    `;
    await lockSourceWorkflowQueuedTx(tx, row.organizationId, row.sourceWorkflowId);
    const expired = await tx<Array<{ id: string }>>`
      update run_steering_attempts set status = 'expired', error_code = 'STEER_UNACKED_FALLBACK',
        forwarding_owner = null, forwarding_lease_expires_at = null, updated_at = now()
       where organization_id = ${row.organizationId} and id = ${row.attemptId}
         and status in ('sending', 'ambiguous')
       returning id
    `;
    if (expired[0]) captureSteeringReceiptTx(tx, row.organizationId, row.attemptId);
  }
  await expirePendingRunSteersTx(tx, context);
}

/**
 * La queue des tentatives que Hermes n'a jamais lues.
 *
 * Les steers sont livrés en FIFO et l'amont concatène les textes non lus avec
 * « \n » (`_requeue_pending_steer`, `interrupt_control.steer`), chacun
 * dépouillé de ses blancs : le texte rendu est donc la QUEUE de la liste des
 * tentatives confirmées, dans l'ordre. À défaut d'une correspondance exacte
 * (un texte retouché en route), toute tentative dont le texte figure dans le
 * rendu : rejouer un message deux fois coûte un tour, le perdre coûte la
 * question de l'opérateur.
 */
export function undeliveredSteerTail<T extends { text: string }>(
  attempts: readonly T[],
  rendered: string,
): T[] {
  const expected = rendered.trim();
  if (!expected) return [];
  const texts = attempts.map((attempt) => attempt.text.trim());
  for (let count = texts.length; count >= 1; count -= 1) {
    if (texts.slice(texts.length - count).join("\n") === expected) {
      return attempts.slice(attempts.length - count);
    }
  }
  return attempts.filter((attempt, index) => texts[index]!.length > 0 && expected.includes(texts[index]!));
}

/**
 * Un steer accepté (202, `run.steered`) est SEULEMENT mis en file côté
 * Hermes : l'agent ne le lit qu'à la frontière d'outil suivante. Quand la
 * réponse finale tombe avant, l'amont ne l'a jamais vu et le rend dans
 * `pending_steer`, sur `run.completed` comme sur le statut du run, « pour que
 * le client le rejoue en tour suivant » (programmatic-integration.md). Sans ce
 * rejeu, le message est absorbé puis perdu : observé le 2026-09-11, trois
 * messages « Pris en compte dans la réponse en cours » et une réponse qui n'en
 * tient aucun compte.
 *
 * Le rejeu réactive le run de repli déjà en base et son workflow, à leur rang
 * d'origine : aucune copie du message, aucun nouveau run. La tentative reste
 * `confirmed` (Hermes l'a bien reçue) et porte `HERMES_STEER_UNDELIVERED`,
 * ce qui rend le rejeu idempotent si le même terminal est relu.
 */
export async function replayUndeliveredRunSteers(
  db: SQL,
  context: RunSteerAckContext,
  pendingSteer: string,
): Promise<number> {
  const rendered = pendingSteer.trim();
  if (!rendered) return 0;
  return withRunReceiptJournal(db, async (tx) => {
    const attempts = await tx<Array<{
      id: string;
      sourceRunId: string;
      sourceWorkflowId: string | null;
      text: string;
    }>>`
      select steer.id, steer.source_run_id as "sourceRunId", source.workflow_id as "sourceWorkflowId", steer.text
        from run_steering_attempts steer
        join runs source on source.organization_id = steer.organization_id and source.id = steer.source_run_id
       where steer.organization_id = ${context.organizationId} and steer.target_run_id = ${context.id}
         and steer.status = 'confirmed' and steer.error_code is null
         and source.status = 'cancelled' and source.completion_kind = 'steered_into_active'
       order by steer.created_at asc, steer.id asc
    `;
    const undelivered = undeliveredSteerTail(attempts, rendered);
    if (undelivered.length === 0) return 0;
    // Même ordre de verrous que l'ACK : runs triés, workflows triés, tentatives
    // triées. La relecture sous verrou protège d'un second lecteur du même
    // terminal : une tentative déjà marquée ou un repli déjà relancé ne
    // bougent plus.
    const runIds = [...new Set([context.id, ...undelivered.map((attempt) => attempt.sourceRunId)])].sort();
    const runs = await tx<Array<{ id: string; status: string; completionKind: string | null }>>`
      select id, status, completion_kind as "completionKind" from runs
       where organization_id = ${context.organizationId} and id in ${tx(runIds)}
       order by id for update
    `;
    const workflowIds = [...new Set(undelivered.map((attempt) => attempt.sourceWorkflowId)
      .filter((id): id is string => id !== null))].sort();
    if (workflowIds.length > 0) await tx`
      select id from workflows
       where organization_id = ${context.organizationId} and id in ${tx(workflowIds)}
       order by id for update
    `;
    const locked = await tx<Array<{ id: string; status: string; errorCode: string | null }>>`
      select id, status, error_code as "errorCode" from run_steering_attempts
       where organization_id = ${context.organizationId}
         and id in ${tx(undelivered.map((attempt) => attempt.id).sort())}
       order by id for update
    `;
    const replayable = undelivered.filter((attempt) => {
      const source = runs.find((run) => run.id === attempt.sourceRunId);
      const lock = locked.find((row) => row.id === attempt.id);
      return lock?.status === "confirmed" && lock.errorCode === null
        && source?.status === "cancelled" && source.completionKind === "steered_into_active";
    });
    if (replayable.length === 0) return 0;
    // UN run pour tous les non-lus, comme l'app de référence rejoue tous ses messages
    // non confirmés en un tour : le plus ancien repli reprend son rang avec
    // l'entrée fusionnée, les suivants se replient dedans.
    const [lead, ...rest] = replayable as [typeof replayable[number], ...typeof replayable];
    await tx`
      update run_steering_attempts set error_code = 'HERMES_STEER_UNDELIVERED', updated_at = now()
       where organization_id = ${context.organizationId}
         and id in ${tx(replayable.map((attempt) => attempt.id))}
    `;
    // `cancelled` → `queued`: legal only for a run `steered_into_active`, as the filter above read under lock.
    await transitionRuns(tx, {
      target: { organizationId: context.organizationId, id: lead.sourceRunId }, fence: "unleased",
      transition: { from: ["cancelled"], fromExternalState: ["settled"], to: { status: "queued", externalState: "not_started" } },
      set: { completionKind: null, eventsComplete: true, errorCode: null, errorMessage: null, endedAt: null, nextAttemptAt: null,
        input: mergeFollowupInputs(replayable.map((attempt) => attempt.text)) },
    });
    if (lead.sourceWorkflowId) await tx`
      update workflows set status = 'queued', final_output = null,
        recovery_state = ${{ steeredIntoRunId: context.id, steeringAttemptId: lead.id, replayedAfterRunId: context.id }},
        error_code = null, error_message = null, ended_at = null, updated_at = now()
       where organization_id = ${context.organizationId} and id = ${lead.sourceWorkflowId}
         and status = 'completed'
    `;
    await recordRunCompletionKindTx(tx, { organizationId: context.organizationId, ids: rest.map((attempt) => attempt.sourceRunId) }, FOLDED_COMPLETION_KIND);
    for (const row of replayable) captureSteeringReceiptTx(tx, context.organizationId, row.id);
    return replayable.length;
  }) as Promise<number>;
}
