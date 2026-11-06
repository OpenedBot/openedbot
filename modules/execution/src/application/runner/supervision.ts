import type { SQL } from "bun";
import type { HermesClient } from "@openedbot/hermes";
import { isServiceStepKind } from "../../domain/run-step";
import { renewRunLease } from "../../sql/run-columns";
import {
  RUN_STEER_POLL_MS,
  forwardNextRunSteer,
  hasPendingRunSteer,
  markPendingRunSteersUnsupported,
} from "../run-steering";
import type { WorkerConfig } from "../worker-config";
import { workflowRemainingMs } from "./admission";
import { createApprovalForwarder } from "./approval-forwarder";
import { approvalForwardErrorCode, expirePendingApprovalTx, forwardReadyApproval } from "./approval-forwarding";
import { heldLease, runKey } from "./lease-transitions";
import type { RunState } from "./run-state";
import { silentRunStillWorking } from "./silent-run";
import type { RunContext } from "./types";
import { describe, log } from "./util";

export type RunSupervision = {
  /** Forwards the decided gates now; concurrent calls share one forwarding. */
  forwardReadyApprovals: () => Promise<void>;
  /** Stops the timers, waits for the steer in flight, detaches the external signal. */
  stop: () => Promise<void>;
};

/**
 * What watches a run while its steps go on: the external stop signal, the
 * run's timeout (bounded by its workflow's deadline), the heartbeat that
 * renews the lease, expires a gate nobody answered and aborts a silent
 * stream, and the poll that forwards decided gates and pending steers.
 * Writes `state.cancelRequested`, `state.runTimedOut`, `state.idleTimedOut`,
 * `state.approvalExpired` and `state.lastFrameAt`; aborts `state.controller`.
 * `stop()` must run once the run is over, whatever its outcome.
 */
export function superviseRun(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  shutdownSignal?: AbortSignal,
): RunSupervision {
  const { controller } = state;
  const runSteerController = new AbortController();
  const stopRunSteer = () => runSteerController.abort(controller.signal.reason ?? "run_stopped");
  controller.signal.addEventListener("abort", stopRunSteer, { once: true });
  const stopForExternalSignal = () => {
    const reason = shutdownSignal?.reason ?? "worker_shutdown";
    if (reason === "cancel_requested") state.cancelRequested = true;
    controller.abort(reason);
  };
  if (shutdownSignal?.aborted) stopForExternalSignal();
  else shutdownSignal?.addEventListener("abort", stopForExternalSignal, { once: true });
  const runTimeout = setTimeout(() => {
    state.runTimedOut = true;
    controller.abort("run_timeout");
  }, Math.max(1, Math.min(config.runTimeoutMs, workflowRemainingMs(context, Date.now()))));
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void maintainLeaseAndApprovals(db, config, context, client, state, forwardReadyApprovals)
      .catch((error) => {
        log("worker.heartbeat_failed", { runId: context.id, error: describe(error) });
        controller.abort("lease_lost");
      })
      .finally(() => { heartbeatBusy = false; });
  }, Math.max(1_000, Math.floor((config.leaseSeconds * 1_000) / 3)));

  const forwardReadyApprovals = createApprovalForwarder(() => forwardReadyApproval(db, config, context, client, state));
  const forwardPendingSteer = createSteerForwarder(db, config, context, client, state, runSteerController.signal);

  // Le poll reste indépendant de la lecture SSE. Réveiller plusieurs fois le
  // même `next()` silencieux accumulerait sinon des handlers Promise pendant
  // les longs outils. Une seule livraison est admise en vol et la clôture du
  // run l'aborte puis l'attend avant de rendre le lease.
  let runSteerPollPromise: Promise<void> | null = null;
  const runSteerPoll = setInterval(() => {
    if (runSteerPollPromise || runSteerController.signal.aborted) return;
    const task = forwardReadyApprovals()
      .catch((error) => {
        log("worker.approval_forward_poll_failed", {
          runId: context.id,
          errorCode: approvalForwardErrorCode(error),
        });
      })
      .then(() => forwardPendingSteer())
      .catch((error) => {
        log("worker.run_steer_poll_failed", { runId: context.id, error: describe(error) });
      })
      .finally(() => {
        if (runSteerPollPromise === task) runSteerPollPromise = null;
      });
    runSteerPollPromise = task;
  }, RUN_STEER_POLL_MS);

  return {
    forwardReadyApprovals,
    async stop() {
      clearInterval(runSteerPoll);
      runSteerController.abort("run_finished");
      const pendingRunSteer = runSteerPollPromise as Promise<void> | null;
      if (pendingRunSteer) await pendingRunSteer.catch(() => undefined);
      controller.signal.removeEventListener("abort", stopRunSteer);
      clearTimeout(runTimeout);
      clearInterval(heartbeat);
      shutdownSignal?.removeEventListener("abort", stopForExternalSignal);
    },
  };
}

async function maintainLeaseAndApprovals(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  forwardReadyApprovals: () => Promise<void>,
): Promise<void> {
  const { controller } = state;
  const lease = await renewRunLease(db, runKey(context), heldLease(config, context), config.leaseSeconds);
  if (!lease) {
    controller.abort("lease_lost_or_cancelled");
    return;
  }
  if (lease.remoteStopState === "requested") {
    state.cancelRequested = true;
    context.remoteStopState = "requested";
    context.errorCode = lease.errorCode;
    context.errorMessage = lease.errorMessage;
    controller.abort("cancel_requested");
    return;
  }
  const expired = await db.begin((tx) => expirePendingApprovalTx(
    tx,
    context.organizationId,
    context.id,
  )) as boolean;
  if (expired) {
    state.approvalExpired = true;
    controller.abort("approval_expired");
    return;
  }
  // Un run en streaming muet trop longtemps est avorté (jamais pendant une approbation),
  // sauf si Hermes le dit encore actif (`silentRunStillWorking`). En polling, aucune frame
  // n'arrive par construction : la réconciliation a sa propre limite.
  if (lease.status === "running" && context.externalState === "streaming" && Date.now() - state.lastFrameAt > config.runInactivityMs) {
    if (await silentRunStillWorking(client, state.hermesRunId, controller.signal, context.id, state.lastFrameAt)) state.lastFrameAt = Date.now();
    else { state.idleTimedOut = true; controller.abort("stream_idle"); return; }
  }
  await forwardReadyApprovals();
}

/**
 * Forwards the next pending steer of the run, once its runtime has said it
 * supports steering (the answer is cached, an unreachable probe is retried
 * after 5 s). Writes `state.lastFrameAt` when a steer is confirmed.
 */
function createSteerForwarder(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  runSteerSignal: AbortSignal,
): () => Promise<void> {
  let runSteerSupported: boolean | null = null;
  let runSteerCapabilityRetryAt = 0;
  return async () => {
    if (!state.hermesRunId || state.controller.signal.aborted || runSteerSignal.aborted) return;
    // Défense en profondeur : l'API ne cible plus un run de service, mais un
    // steer déjà en base (ou un client ancien) ne doit jamais entrer dans une
    // session d'extraction. Il reste dans sa file : le run de repli répond.
    if (isServiceStepKind(context.stepKind)) return;
    // Livraison bornée (MAX_RUN_STEER_ATTEMPTS) et idempotente sur
    // l'id de tentative. Un `sending` de crash n'est pas rejoué ici.
    const steerContext = {
      id: context.id,
      organizationId: context.organizationId,
      threadId: context.threadId,
      leaseGeneration: context.leaseGeneration,
    };
    if (!await hasPendingRunSteer(db, steerContext)) return;
    if (runSteerSupported === null) {
      if (Date.now() < runSteerCapabilityRetryAt) return;
      try {
        runSteerSupported = await client.runSteerSupported();
      } catch (error) {
        // Une sonde GET injoignable ne doit ni casser le run actif, ni faire
        // tomber le follow-up hors de sa file durable. On réessaie plus tard.
        runSteerCapabilityRetryAt = Date.now() + 5_000;
        log("worker.run_steer_capability_failed", {
          runId: context.id,
          error: describe(error),
        });
        return;
      }
    }
    if (!runSteerSupported) {
      await markPendingRunSteersUnsupported(db, steerContext);
      return;
    }
    const outcome = await forwardNextRunSteer(
      db,
      client,
      { workerId: config.workerId, leaseSeconds: config.leaseSeconds },
      steerContext,
      // Read at send time, as the closure did before S2e (0002 section 9.4).
      state.hermesRunId as string,
      runSteerSignal,
    );
    if (outcome === "confirmed") state.lastFrameAt = Date.now();
    if (outcome === "ambiguous") {
      log("worker.run_steer_outcome_unknown", { runId: context.id });
    }
  };
}
