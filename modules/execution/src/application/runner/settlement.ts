import type { SQL } from "bun";
import { type HermesClient, HermesClientError } from "@openedbot/hermes";
import type { RunTrace } from "@openedbot/platform-observability/run-trace";
import type { WorkerConfig } from "../worker-config";
import {
  processRequestedCancellation,
  reconcileRequestedCancellation,
  requestedCancellationRecoveryMode,
} from "./cancel";
import { NamedRunError, failureCode, handleFailure, markRunUnknown } from "./failure";
import {
  confirmRemoteStop,
  markRemoteStopAmbiguous,
  requestRemoteStop,
  settleResumedRunStatus,
  switchToPolling,
} from "./lease-transitions";
import { fallbackAwareError } from "./provider-recovery";
import { type ReconcileStopCause, reconcileHermesRun } from "./reconcile";
import type { RunState } from "./run-state";
import { watchdogStopCause } from "./silent-run";
import type { RunContext } from "./types";
import { log } from "./util";

/**
 * Réconciliation of a run claimed with a stop already requested: a run
 * whose Hermes outcome only needs reading is reconciled, any other is
 * cancelled. Writes `state.terminal`.
 */
export async function settleRequestedCancellation(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
): Promise<void> {
  if (state.hermesRunId && requestedCancellationRecoveryMode(context.externalState) === "reconcile_only") {
    await reconcileRequestedCancellation(db, config, context, client, state.hermesRunId);
  } else {
    await processRequestedCancellation(db, config, context, client, state.hermesRunId);
  }
  state.terminal = true;
}

/**
 * Réconciliation once the stream of `streamRunId` ended: a stop requested
 * meanwhile cancels the run; a stream that ended without a terminal event,
 * and was not aborted, hands over to polling by status. Writes
 * `state.cancelRequested`, `state.terminal`, `context.externalState` and
 * the stop fields of `context`.
 */
export async function settleStreamEnd(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  trace: RunTrace,
  streamRunId: string,
): Promise<void> {
  const stopRows = await db<Array<{
    remoteStopState: RunContext["remoteStopState"];
    errorCode: string | null;
    errorMessage: string | null;
  }>>`
    select remote_stop_state as "remoteStopState", error_code as "errorCode", error_message as "errorMessage"
      from runs where id = ${context.id} and organization_id = ${context.organizationId}
        and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
  `;
  if (stopRows[0]?.remoteStopState === "requested") {
    state.cancelRequested = true;
    context.remoteStopState = "requested";
    context.errorCode = stopRows[0].errorCode;
    context.errorMessage = stopRows[0].errorMessage;
    await processRequestedCancellation(db, config, context, client, state.hermesRunId);
    state.terminal = true;
    return;
  }
  if (!state.terminal && !state.controller.signal.aborted) {
    await switchToPolling(db, config, context);
    context.externalState = "polling";
    await reconcileHermesRun(db, config, context, client, streamRunId, state.controller.signal, trace);
    state.terminal = true;
  }
}

/**
 * Réconciliation of a run whose steps threw. An abort is settled by its
 * cause (stop requested, gate expired, idle or run timeout); shutdown, lost
 * lease and other aborts leave the run to the queue. Une panne LOCALE après
 * création (flux coupé, trame SSE invalide, écriture refusée...) ne dit rien
 * de l'issue du run distant, qui peut encore agir : son identifiant connu est
 * réconcilié par le statut, jamais clos en `failed` à l'aveugle. Without a
 * Hermes id, the run fails with the error, named after a fallback.
 */
export async function settleRunError(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  trace: RunTrace,
  error: unknown,
): Promise<void> {
  const { controller } = state;
  const hermesRunId = state.hermesRunId;
  if (controller.signal.aborted) {
    // Un abort d'inactivité fait échouer le run (retryable); les autres (shutdown,
    // perte de bail, annulation) laissent la reprise à la file.
    if (state.cancelRequested) {
      await processRequestedCancellation(db, config, context, client, hermesRunId);
    } else if (state.approvalExpired) {
      // PERM2-9: the three named outcomes of a gate nobody answered are a
      // refusal (on the gate), `APPROVAL_EXPIRED` once the stop is
      // reconciled, `APPROVAL_EXPIRY_STOP_OUTCOME_UNKNOWN` when it is not.
      if (hermesRunId) {
        await stopAndReconcileAfterAbort(
          db, config, context, client, trace,
          hermesRunId,
          "APPROVAL_EXPIRY_STOP_OUTCOME_UNKNOWN",
          "L’arrêt du run après expiration de l’autorisation n’a pas pu être confirmé.",
          { errorCode: "APPROVAL_EXPIRED", message: "La demande d’autorisation a expiré sans réponse. Le run a été arrêté." },
        );
      } else {
        await handleFailure(db, config, context, new NamedRunError(
          "APPROVAL_EXPIRED",
          "La demande d’autorisation a expiré sans réponse.",
        ));
      }
    } else if (state.idleTimedOut || state.runTimedOut) {
      if (!hermesRunId) {
        const createWasDefinitelyNotSent = error instanceof HermesClientError && error.requestDelivery === "not_sent";
        if (context.externalState === "creating" && !createWasDefinitelyNotSent) {
          await markRunUnknown(db, config, context, "HERMES_TIMEOUT_OUTCOME_UNKNOWN",
            "Le délai a expiré pendant une création Hermes sans identifiant réconciliable.");
        } else {
          await handleFailure(db, config, context, new NamedRunError(
            "RUN_TIMEOUT_BEFORE_CREATE",
            "Le délai a expiré avant qu’un run Hermes soit créé.",
          ));
        }
        return;
      }
      await stopAndReconcileAfterAbort(
        db, config, context, client, trace,
        hermesRunId,
        "HERMES_STOP_OUTCOME_UNKNOWN",
        "L’arrêt Hermes n’a pas pu être confirmé.",
        watchdogStopCause(state.idleTimedOut, config.runInactivityMs),
      );
    }
    return;
  }
  if (hermesRunId) {
    const code = failureCode(error);
    const message = error instanceof Error ? error.message : "Panne locale après la création Hermes.";
    log("worker.local_failure_reconcile", { runId: context.id, organizationId: context.organizationId, code });
    await switchToPolling(db, config, context, { code, message });
    context.externalState = "polling";
    // The link failed during the resume itself, before the run left
    // `starting`: an open gate must still read `awaiting_approval`, or the
    // heartbeat never forwards its answer and Hermes stays parked at it.
    await settleResumedRunStatus(db, config, context);
    await reconcileHermesRun(db, config, context, client, hermesRunId, controller.signal, trace);
    return;
  }
  await handleFailure(db, config, context, fallbackAwareError(error, state.retryState));
}

/**
 * Stops the Hermes run after an abort, then reconciles it within
 * `reconciliationTimeoutMs`; a stop nobody confirmed leaves the run
 * `unknown` with `unknownCode`.
 */
async function stopAndReconcileAfterAbort(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  trace: RunTrace,
  knownHermesRunId: string,
  unknownCode: string,
  unknownMessage: string,
  stopCause?: ReconcileStopCause,
): Promise<void> {
  await requestRemoteStop(db, config, context);
  context.externalState = "stopping";
  context.remoteStopState = "requested";
  try {
    await client.stopRun(knownHermesRunId);
    if (!await confirmRemoteStop(db, config, context)) return;
    context.externalState = "polling";
    context.remoteStopState = "confirmed";
    const pollController = new AbortController();
    const pollTimeout = setTimeout(
      () => pollController.abort("reconciliation_timeout"),
      config.reconciliationTimeoutMs,
    );
    try {
      await reconcileHermesRun(db, config, context, client, knownHermesRunId, pollController.signal, trace, stopCause);
    } finally {
      clearTimeout(pollTimeout);
    }
  } catch (error) {
    await markRemoteStopAmbiguous(db, config, context);
    await markRunUnknown(
      db,
      config,
      context,
      unknownCode,
      error instanceof Error ? error.message : unknownMessage,
    );
  }
}
