import type { SQL } from "bun";
import {
  fitHermesRunImages,
  type HermesClient,
  HermesClientError,
  hermesToolsetFingerprint,
  noteHermesPreflightLink,
  type HermesRunImage,
} from "@openedbot/hermes";
import { projectToolResults } from "../domain/agent-tool-results";
import { DELTA_FLUSH_MS, HermesEventNormalizer } from "../domain/hermes-events";
import { fallbackIdempotencyKey, providerAuthRequiredPayload, type ProviderRetryState } from "./provider-fallback";
import { imageNotSentNote } from "@openedbot/conversation/domain/attachments";
import { readContextUsage } from "@openedbot/runtimes/domain/runtime/context-usage";
import { withBotModeInstructions } from "@openedbot/roster/domain/bot-mode";
import { buildRuntimeMemoryBlock } from "@openedbot/roster/domain/bot-memory";
import { isServiceStepKind } from "../domain/run-step";
import {
  buildLearnInput,
  buildLearningBlock,
  isLearnRequest,
  runtimeCanLearn,
} from "@openedbot/roster/domain/bot-learning";
import { createRuntimeClient } from "./runtime-client";
import { readWarmModelSelection, takeWarmOrSelectModel, warmModelSelectionKey } from "./warm-model-selection";
import { buildPersonaDraftInstructions } from "@openedbot/roster/domain/persona-draft";
import { buildCompactionInstructions } from "@openedbot/conversation/domain/thread-compaction";
import { ROUTINE_TOOL_RUNTIME_NAME, withRoutineRunKey } from "../domain/routine-tool";
import { BOT_SETTINGS_TOOL_RUNTIME_NAME, withBotSettingsRunKey } from "../domain/bot-settings-tool";
import { signRoutineRunKey } from "./routine-run-key";
import { signBotSettingsRunKey } from "./bot-settings-run-key";
import { withAutonomousStepLimits } from "@openedbot/roster/domain/autonomous-workflow";
import { RunTrace, runTrace } from "@openedbot/platform-observability/run-trace";
import type { WorkerConfig } from "./worker-config";
import type { ClaimedRun } from "./queue";
import {
  RUN_STEER_POLL_MS,
  forwardNextRunSteer,
  hasPendingRunSteer,
  markPendingRunSteersUnsupported,
  reconcileRunSteerEvent,
} from "./run-steering";
import {
  processRequestedCancellation,
  reconcileRequestedCancellation,
  requestedCancellationRecoveryMode,
} from "./runner/cancel";
import { readContext } from "./runner/context";
import { NamedRunError, handleFailure, markRunUnknown, retiredServiceStep } from "./runner/failure";
import { conversationHistory, loadRunImages } from "./runner/history";
import { type DmStepPrompt, assignedPlaybookBlock, dmInstructions, withTurnGuidance } from "./runner/instructions";
import { createApprovalForwarder } from "./runner/approval-forwarder";
import { lockWorkflowTx, permissionRuleSourceFor } from "./runner/permission-rule-sources";
import { checkBeforeForwardTx } from "./runner/permission-gate";
import type { GateIdentity } from "../domain/gate-identity";
import { persistEvents } from "./runner/persist";
import {
  gatherIndependentPreflight,
  linkInstant,
  missingRunProfile,
  preflightToolsets,
  resolveToolsetScope,
} from "./runner/preflight";
import {
  type ResolvedRunSelection,
  failWithoutUsableProvider,
  fallbackAwareError,
  persistResolvedRunModel,
  providerAuthRequiredError,
  recoverProviderFailure,
  resolveSelectionForNewRun,
} from "./runner/provider-recovery";
import { pendingSteerOf, reconcileHermesRun, replayUndeliveredRunSteersSafely, type ReconcileStopCause } from "./runner/reconcile";
import { groupSendState, packRoomHistory, prepareGroupTurn } from "./runner/rooms";
import { readAgentTranscript } from "./runner/transcript";
import {
  MAX_EVENT_REPLAY_ATTEMPTS,
  classifyHermesFrame,
  eventReplayDelayMs,
  isReplayableStreamFailure,
  waitForHermesEventOrFlush,
} from "./runner/stream";
import type { RunContext } from "./runner/types";
import { describe, log, pollWait } from "./runner/util";
import { readWorkflowSessionCounters } from "./runner/workflows";
import { isTodoTool } from "../domain/agent-tool-call";

// Re-exports for the importers that still go through this module.
export { loadAssignedPlaybooks } from "./runner/instructions";
export { isRunEventsLeaseFence, persistEvents } from "./runner/persist";
export { resolveToolsetScope } from "./runner/preflight";
export { resolveRunnableSelection } from "./runner/provider-recovery";

/**
 * Les outils dont la fin justifie une relecture du transcript. Chacun écrit
 * quelque chose que le SSE ne transporte pas : la liste de tâches pour
 * `todo`, les sources pour une recherche web.
 */
export const TRANSCRIPT_TOOLS = new Set(["todo", "todo_list", "web_search", "search"]);

export async function executeRun(
  db: SQL,
  config: WorkerConfig,
  claimed: ClaimedRun,
  shutdownSignal?: AbortSignal,
): Promise<void> {
  // Sans trace ouverte par la réclamation (appel direct), les marques tombent
  // dans une trace détachée que personne ne journalise.
  const trace = runTrace(claimed.id) ?? new RunTrace();
  const context = await trace.span("preflight.read_context", () => readContext(db, config, claimed));
  if (!context) return;
  trace.set("resumed", Boolean(context.hermesRunId));
  trace.set("reachability", context.reachability);
  trace.set("workflow", Boolean(context.workflowId));
  const importing = await trace.span("preflight.import_check", () => db<Array<{ slug: string }>>`
    select slug from profile_import_items where organization_id = ${context.organizationId}
      and bot_id = ${context.botId} and reservation_released_at is null limit 1
  `);
  if (importing.length) {
    await handleFailure(db, config, context, new NamedRunError("PROFILE_IMPORT_IN_PROGRESS", "Ce profil est encore en cours d’import ou à vérifier dans les réglages Hermes."));
    return;
  }
  // PERM2-2: under `v2` the pipeline only sees the writes the host submits.
  // A plugin not proven in the bot's mode (restart pending, older host,
  // reconciliation not done yet) would let them through: no run starts.
  if (context.hostPolicyRequired && !context.hostPolicyProven) {
    await handleFailure(db, config, context, new NamedRunError(
      "PERMISSION_POLICY_NOT_EFFECTIVE",
      "Les permissions de ce bot ne sont pas encore actives sur votre serveur. Si un redémarrage du gateway est proposé, lancez-le depuis les réglages du bot, dans « Règles d’approbation », puis renvoyez votre message.",
    ));
    return;
  }
  const activeContext: RunContext = context;
  if (context.workflowId && context.stackDepth > 0 && !context.callerBotId) {
    await handleFailure(db, config, context, new NamedRunError(
      "WORKFLOW_CALLER_MISSING",
      "Le bot appelant n’existe plus; la chaîne ne peut pas reprendre sans risquer une synthèse incorrecte.",
    ));
    return;
  }
  if (context.workflowId) {
    await trace.span("preflight.workflow_running", () => db`
      update workflows workflow set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
       where workflow.organization_id = ${context.organizationId} and workflow.id = ${context.workflowId}
         and workflow.status = 'queued'
         and exists (
           select 1 from runs run where run.organization_id = ${context.organizationId} and run.id = ${context.id}
             and run.lease_owner = ${config.workerId} and run.lease_generation = ${context.leaseGeneration}
             and run.status = 'starting'
         )
    `);
    if (context.workflowStatus === "queued") activeContext.workflowStatus = "running";
  }
  let client: HermesClient;
  try {
    client = createRuntimeClient(context, config);
    log("worker.runtime_transport", { runId: context.id, runtimeId: context.runtimeId, transport: context.reachability === "direct" ? "direct" : "relay", profile: context.reachability === "direct" ? null : context.hermesProfile });
  } catch {
    await handleFailure(db, config, context, new NamedRunError(
      "RUNTIME_CREDENTIALS_MISSING",
      "Le runtime n’a pas d’identifiants exploitables. Restaurez la clé de chiffrement ou remplacez les accès.",
    ));
    return;
  }
  let cancelRequested = context.remoteStopState === "requested";
  const controller = new AbortController();
  const runSteerController = new AbortController();
  const stopRunSteer = () => runSteerController.abort(controller.signal.reason ?? "run_stopped");
  controller.signal.addEventListener("abort", stopRunSteer, { once: true });
  const stopForExternalSignal = () => {
    const reason = shutdownSignal?.reason ?? "worker_shutdown";
    if (reason === "cancel_requested") cancelRequested = true;
    controller.abort(reason);
  };
  if (shutdownSignal?.aborted) stopForExternalSignal();
  else shutdownSignal?.addEventListener("abort", stopForExternalSignal, { once: true });
  let terminal = false;
  let hermesRunId = context.hermesRunId;
  let activeSelection: ResolvedRunSelection | null = null;
  let retryState: ProviderRetryState = {
    fallbackAttempted: false,
    extraModelTried: false,
    fromProvider: null,
    fallback: null,
  };
  let runCreateArgs: {
    input: string;
    images: HermesRunImage[];
    instructions: string;
    history: Array<{ role: string; content: string }>;
  } | null = null;
  // Watchdog d'inactivité: mis à jour à chaque frame; contrôlé, avec le statut, dans le heartbeat.
  let lastFrameAt = Date.now();
  let idleTimedOut = false;
  let runTimedOut = false;
  let approvalExpired = false;
  let runSteerSupported: boolean | null = null;
  let runSteerCapabilityRetryAt = 0;
  const workflowRemainingMs = context.workflowDeadlineAt && context.workflowStatus !== "reconciling"
    ? new Date(context.workflowDeadlineAt).getTime() - Date.now()
    : Number.POSITIVE_INFINITY;
  const runTimeout = setTimeout(() => {
    runTimedOut = true;
    controller.abort("run_timeout");
  }, Math.max(1, Math.min(config.runTimeoutMs, workflowRemainingMs)));
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    void maintainLeaseAndApprovals()
      .catch((error) => {
        log("worker.heartbeat_failed", { runId: activeContext.id, error: describe(error) });
        controller.abort("lease_lost");
      })
      .finally(() => { heartbeatBusy = false; });
  }, Math.max(1_000, Math.floor((config.leaseSeconds * 1_000) / 3)));

  async function maintainLeaseAndApprovals(): Promise<void> {
    const rows = await db<Array<{
      status: string;
      remoteStopState: RunContext["remoteStopState"];
      errorCode: string | null;
      errorMessage: string | null;
    }>>`
      update runs set heartbeat_at = now(),
        lease_expires_at = now() + (${config.leaseSeconds} * interval '1 second'), updated_at = now()
       where id = ${activeContext.id} and organization_id = ${activeContext.organizationId}
         and lease_owner = ${config.workerId} and lease_generation = ${activeContext.leaseGeneration}
         and status in ('starting','running','awaiting_approval')
       returning status, remote_stop_state as "remoteStopState",
         error_code as "errorCode", error_message as "errorMessage"
    `;
    if (!rows[0]) {
      controller.abort("lease_lost_or_cancelled");
      return;
    }
    if (rows[0].remoteStopState === "requested") {
      cancelRequested = true;
      activeContext.remoteStopState = "requested";
      activeContext.errorCode = rows[0].errorCode;
      activeContext.errorMessage = rows[0].errorMessage;
      controller.abort("cancel_requested");
      return;
    }
    const expired = await db.begin((tx) => expirePendingApprovalTx(
      tx,
      activeContext.organizationId,
      activeContext.id,
    )) as boolean;
    if (expired) {
      approvalExpired = true;
      controller.abort("approval_expired");
      return;
    }
    // Un run en streaming muet trop longtemps est avorté (jamais pendant une approbation).
    // En polling, aucune frame n'arrive par construction : la réconciliation a sa
    // propre limite, et ce watchdog y arrêtait un run sain au bout de 2 minutes.
    if (
      rows[0].status === "running" && activeContext.externalState === "streaming" &&
      Date.now() - lastFrameAt > config.runInactivityMs
    ) {
      idleTimedOut = true;
      controller.abort("stream_idle");
      return;
    }
    await forwardReadyApprovals();
  }

  const forwardReadyApprovals = createApprovalForwarder(async () => {
    if (!hermesRunId) return;
    // Appelé toutes les RUN_STEER_POLL_MS : une lecture simple écarte le cas
    // courant (rien de prêt) avant la transaction et ses verrous sur le run.
    const ready = await db<Array<{ one: number }>>`
      select 1 as one from approval_requests
       where organization_id = ${activeContext.organizationId} and run_id = ${activeContext.id}
         and selected_choice is not null and forward_state = 'ready'
       limit 1
    `;
    if (!ready[0]) return;
    // PERM2-9: "Never wait" through the port, resolved before the locks.
    const unattendedFrom = await permissionRuleSourceFor(activeContext.organizationId);
    const approvals = await db.begin(async (tx) => {
      const run = await tx<Array<{ workflowId: string | null }>>`
        select workflow_id as "workflowId" from runs
         where organization_id = ${activeContext.organizationId} and id = ${activeContext.id}
           and lease_owner = ${config.workerId} and lease_generation = ${activeContext.leaseGeneration}
           and status = 'awaiting_approval'
         for update
      `;
      if (!run[0]) return [];
      const neverWait = await lockWorkflowTx(tx as unknown as SQL, activeContext.organizationId, run[0].workflowId, unattendedFrom);
      const candidates = await tx<Array<{
        id: string;
        choice: "once" | "deny";
        decidedByKind: string | null;
        revisionSeen: number | string | null;
        gateKind: GateIdentity["gateKind"];
        toolKey: string | null;
        gateArgs: Record<string, unknown> | null;
        descriptorVersion: number | null;
        hermesRequestId: string | null;
        choices: unknown;
        detail: Record<string, unknown> | null;
      }>>`
        select id, selected_choice as choice, decided_by_kind as "decidedByKind",
               permission_revision_seen as "revisionSeen", gate_kind as "gateKind", tool_key as "toolKey",
               gate_args as "gateArgs", descriptor_version as "descriptorVersion",
               hermes_request_id as "hermesRequestId", choices, decision_detail as detail
          from approval_requests
         where organization_id = ${activeContext.organizationId} and run_id = ${activeContext.id}
           and selected_choice is not null and forward_state = 'ready'
         order by gate_ordinal asc limit 1
         for update skip locked
      `;
      const candidate = candidates[0];
      if (!candidate) return [];
      // PERM2-1, the linearization point of a `v2` decision: the bot's
      // revision is read again here, `for share`, under this claim.
      const check = await checkBeforeForwardTx(tx as unknown as SQL, {
        organizationId: activeContext.organizationId,
        botId: activeContext.botId,
        neverWait,
        planOnly: activeContext.planOnly === true,
      }, {
        choice: candidate.choice,
        decidedByKind: candidate.decidedByKind,
        revisionSeen: candidate.revisionSeen,
        gate: {
          hermesRequestId: candidate.hermesRequestId, gateKind: candidate.gateKind, toolKey: candidate.toolKey,
          gateArgs: candidate.gateArgs, descriptorVersion: candidate.descriptorVersion,
        },
        choices: Array.isArray(candidate.choices) ? candidate.choices : [],
      });
      let choice = candidate.choice;
      let rewrite: { stage: string | null; revision: number | null; detail: Record<string, unknown>; policy: string | null } | null = null;
      if (check.action === "deny") {
        // A human `once` the policy now forbids leaves as `deny`, and says so.
        choice = "deny";
        rewrite = { stage: null, revision: null, detail: { ...candidate.detail, humanOverridden: check.reason }, policy: null };
      } else if (check.action === "redecide") {
        // The policy moved between the decision and this claim. A decision
        // that now needs a human cannot raise a card from here without an
        // out-of-sequence event: it is refused, and the bot's next attempt
        // is decided at the new revision.
        const redone = check.resolution;
        choice = redone.choice ?? "deny";
        rewrite = {
          stage: redone.decision.stage,
          revision: redone.revision,
          detail: { ...redone.detail, redecided: true, ...(redone.choice ? {} : { policyChanged: true }) },
          policy: redone.decision.effectiveMode,
        };
        log("approval.decision", { runId: activeContext.id, stage: redone.decision.stage, outcome: redone.choice ?? "deny", reason: redone.choice ? redone.decision.reason : "policy_changed", redecided: true });
      }
      const rows = await tx<Array<{
        id: string;
        choice: "once" | "deny";
        forwardingEpoch: number;
        hermesRequestId: string | null;
      }>>`
        update approval_requests set forward_state = 'sending',
          forwarding_owner = ${config.workerId}, forwarding_epoch = forwarding_epoch + 1,
          forwarding_lease_expires_at = now() + (${config.leaseSeconds} * interval '1 second'),
          selected_choice = ${choice}, status = ${choice === "deny" ? "denied" : "approved"},
          decision_stage = coalesce(${rewrite?.stage ?? null}, decision_stage),
          permission_revision_seen = coalesce(${rewrite?.revision ?? null}, permission_revision_seen),
          decision_detail = coalesce(${rewrite?.detail ?? null}, decision_detail),
          resolved_by_policy = case when decided_by_kind = 'policy'
            then coalesce(${rewrite?.policy ?? null}, resolved_by_policy) else resolved_by_policy end
         where id = ${candidate.id} and organization_id = ${activeContext.organizationId}
        returning id, selected_choice as choice,
          forwarding_epoch as "forwardingEpoch", hermes_request_id as "hermesRequestId"
      `;
      return rows;
    }) as Array<{ id: string; choice: "once" | "deny"; forwardingEpoch: number; hermesRequestId: string | null }>;
    const approval = approvals[0];
    if (!approval) return;
    try {
      // PERM2-A: the exact gate when Hermes named it; positional otherwise
      // (a runtime older than `request_id`, or a row from before 0137).
      await client.respondApproval(hermesRunId, approval.choice, controller.signal, approval.hermesRequestId);
      const confirmed = await db.begin(async (tx) => {
        const run = await tx<Array<{ workflowId: string | null; status: string }>>`
          select workflow_id as "workflowId", status from runs
           where id = ${activeContext.id} and organization_id = ${activeContext.organizationId}
           for update
        `;
        const workflow = run[0]?.workflowId
          ? (await tx<Array<{ status: string }>>`
              select status from workflows
               where organization_id = ${activeContext.organizationId} and id = ${run[0].workflowId}
               for update
            `)[0]
          : null;
        const gates = await tx<Array<{ id: string }>>`
          update approval_requests set forwarded_at = now(), forward_state = 'confirmed',
            forwarding_owner = null, forwarding_lease_expires_at = null
           where id = ${approval.id} and organization_id = ${activeContext.organizationId}
             and forward_state = 'sending' and forwarding_owner = ${config.workerId}
             and forwarding_epoch = ${approval.forwardingEpoch}
          returning id
        `;
        const fenced = run[0] && ["starting", "running", "awaiting_approval"].includes(run[0].status);
        if (!fenced || !gates[0]) {
          await tx`
            update approval_requests set forward_state = 'ambiguous', forwarding_owner = null,
              forwarding_lease_expires_at = null
             where id = ${approval.id} and organization_id = ${activeContext.organizationId}
               and forward_state <> 'confirmed'
          `;
          await tx`
            update runs set status = 'unknown', external_state = 'ambiguous', events_complete = false,
              remote_stop_state = case when remote_stop_state = 'requested' then 'ambiguous' else remote_stop_state end,
              error_code = 'APPROVAL_FORWARD_OUTCOME_UNKNOWN',
              error_message = 'Hermes a reçu la décision mais sa confirmation locale a été perdue.',
              lease_owner = null, lease_expires_at = null, ended_at = null, updated_at = now()
             where id = ${activeContext.id} and organization_id = ${activeContext.organizationId}
               and status in ('starting','running','awaiting_approval','cancelled')
          `;
          if (run[0]?.workflowId) await tx`
            update workflows set status = 'unknown', error_code = 'APPROVAL_FORWARD_OUTCOME_UNKNOWN',
              error_message = 'Hermes a reçu la décision mais sa confirmation locale a été perdue.',
              recovery_state = ${{ runId: activeContext.id, needsReview: true }}, ended_at = null, updated_at = now()
             where organization_id = ${activeContext.organizationId} and id = ${run[0].workflowId}
               and status not in ('completed','failed','expired')
          `;
          return false;
        }
        await tx`
          update runs set status = 'running', updated_at = now()
          where id = ${activeContext.id} and organization_id = ${activeContext.organizationId}
            and lease_owner = ${config.workerId} and lease_generation = ${activeContext.leaseGeneration}
            and status = 'awaiting_approval'
        `;
        if (activeContext.workflowId && workflow) await tx`
          update workflows set status = 'running', updated_at = now()
           where organization_id = ${activeContext.organizationId} and id = ${activeContext.workflowId}
             and status = 'awaiting_approval'
        `;
        return true;
      });
      if (!confirmed) controller.abort("approval_forward_ambiguous");
      // Une approbation peut rester légitimement ouverte au-delà du timeout
      // d'inactivité. Sa transmission est une activité : le flux repart de zéro
      // au lieu d'être avorté au heartbeat suivant avec l'ancienne horloge.
      lastFrameAt = Date.now();
    } catch (error) {
      const safe = error instanceof HermesClientError && error.requestDelivery === "not_sent";
      if (safe) {
        await db`
          update approval_requests set forward_state = 'ready', forwarding_owner = null,
            forwarding_lease_expires_at = null
           where id = ${approval.id} and organization_id = ${activeContext.organizationId}
             and forward_state = 'sending' and forwarding_owner = ${config.workerId}
             and forwarding_epoch = ${approval.forwardingEpoch}
        `;
      } else {
        await db`
          update approval_requests set forward_state = 'ambiguous', forwarding_owner = null,
            forwarding_lease_expires_at = null
           where id = ${approval.id} and organization_id = ${activeContext.organizationId}
             and forward_state = 'sending' and forwarding_owner = ${config.workerId}
             and forwarding_epoch = ${approval.forwardingEpoch}
        `;
        await markRunUnknown(db, config, activeContext, "APPROVAL_FORWARD_OUTCOME_UNKNOWN",
          "Hermes a pu recevoir la décision d’autorisation; aucune retransmission automatique.");
        controller.abort("approval_forward_ambiguous");
      }
    }
  });

  const approvalForwardErrorCode = (error: unknown) =>
    error instanceof HermesClientError ? error.code : "APPROVAL_FORWARD_FAILED";

  async function forwardPendingSteer(): Promise<void> {
    if (!hermesRunId || controller.signal.aborted || runSteerController.signal.aborted) return;
    // Défense en profondeur : l'API ne cible plus un run de service, mais un
    // steer déjà en base (ou un client ancien) ne doit jamais entrer dans une
    // session d'extraction. Il reste dans sa file : le run de repli répond.
    if (isServiceStepKind(activeContext.stepKind)) return;
    // OHB-117 : livraison bornée (MAX_RUN_STEER_ATTEMPTS) et idempotente sur
    // l'id de tentative. Un `sending` de crash n'est pas rejoué ici.
    const steerContext = {
      id: activeContext.id,
      organizationId: activeContext.organizationId,
      threadId: activeContext.threadId,
      leaseGeneration: activeContext.leaseGeneration,
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
          runId: activeContext.id,
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
      hermesRunId,
      runSteerController.signal,
    );
    if (outcome === "confirmed") lastFrameAt = Date.now();
    if (outcome === "ambiguous") {
      log("worker.run_steer_outcome_unknown", { runId: activeContext.id });
    }
  }

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
          runId: activeContext.id,
          errorCode: approvalForwardErrorCode(error),
        });
      })
      .then(() => forwardPendingSteer())
      .catch((error) => {
        log("worker.run_steer_poll_failed", { runId: activeContext.id, error: describe(error) });
      })
      .finally(() => {
        if (runSteerPollPromise === task) runSteerPollPromise = null;
      });
    runSteerPollPromise = task;
  }, RUN_STEER_POLL_MS);

  async function stopAndReconcileAfterAbort(
    knownHermesRunId: string,
    unknownCode: string,
    unknownMessage: string,
    stopCause?: ReconcileStopCause,
  ): Promise<void> {
    await db`
      update runs set external_state = 'stopping', remote_stop_state = 'requested', updated_at = now()
       where id = ${activeContext.id} and organization_id = ${activeContext.organizationId}
         and lease_owner = ${config.workerId} and lease_generation = ${activeContext.leaseGeneration}
         and status in ('starting','running','awaiting_approval')
    `;
    activeContext.externalState = "stopping";
    activeContext.remoteStopState = "requested";
    try {
      await client.stopRun(knownHermesRunId);
      const confirmed = await db<Array<{ id: string }>>`
        update runs set remote_stop_state = 'confirmed', external_state = 'polling', updated_at = now()
         where id = ${activeContext.id} and organization_id = ${activeContext.organizationId}
           and lease_owner = ${config.workerId} and lease_generation = ${activeContext.leaseGeneration}
           and status in ('starting','running','awaiting_approval')
         returning id
      `;
      if (!confirmed[0]) return;
      activeContext.externalState = "polling";
      activeContext.remoteStopState = "confirmed";
      const pollController = new AbortController();
      const pollTimeout = setTimeout(
        () => pollController.abort("reconciliation_timeout"),
        config.reconciliationTimeoutMs,
      );
      try {
        await reconcileHermesRun(db, config, activeContext, client, knownHermesRunId, pollController.signal, trace, stopCause);
      } finally {
        clearTimeout(pollTimeout);
      }
    } catch (error) {
      await db`
        update runs set remote_stop_state = 'ambiguous', updated_at = now()
         where id = ${activeContext.id} and organization_id = ${activeContext.organizationId}
           and lease_owner = ${config.workerId} and lease_generation = ${activeContext.leaseGeneration}
      `;
      await markRunUnknown(
        db,
        config,
        activeContext,
        unknownCode,
        error instanceof Error ? error.message : unknownMessage,
      );
    }
  }

  try {
    if (cancelRequested) {
      if (hermesRunId && requestedCancellationRecoveryMode(activeContext.externalState) === "reconcile_only") {
        await reconcileRequestedCancellation(db, config, activeContext, client, hermesRunId);
      } else {
        await processRequestedCancellation(db, config, activeContext, client, hermesRunId);
      }
      terminal = true;
      return;
    }
    if (
      context.workflowStatus !== "reconciling" &&
      context.workflowDeadlineAt &&
      new Date(context.workflowDeadlineAt).getTime() <= Date.now()
    ) {
      await handleFailure(db, config, context, new NamedRunError(
        "WORKFLOW_DEADLINE_EXCEEDED",
        "La durée maximale du workflow est atteinte avant cette étape.",
      ));
      return;
    }
    // Inventory and scope reads run in parallel. Session creation waits for
    // their capability gate; model, history and createRun consume the result.
    // The model catalogue read rides with the inventory and the replay probe
    // starts at the gate (OHB-137): neither is serial before the event stream.
    const warmModelKey = hermesRunId ? null : warmModelSelectionKey({
      organizationId: context.organizationId,
      runtimeId: context.runtimeId,
      profile: context.hermesProfile,
      provider: context.provider,
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      linkConnectedAt: linkInstant(context.linkConnectedAt),
    });
    const warmSelection = readWarmModelSelection(warmModelKey, Date.now());
    const {
      toolsets: toolsetInventory,
      modelCatalog,
      replayProbe,
    } = await gatherIndependentPreflight(trace, {
      toolsets: () => preflightToolsets(client, context),
      toolsetScope: () => resolveToolsetScope(client, context),
      // Le titre d'une session de SALON est le nom du salon, pas celui du membre
      // dont c'est le tour : le premier orateur baptisait la session à son nom.
      ensureSession: () => client.ensureSession(
        context.sessionId,
        context.groupId ? context.threadTitle : context.botName,
        controller.signal,
      ),
      missingProfile: () => missingRunProfile(client, context),
      // A resumed run, or a warm selection still inside its TTL, never reads
      // the catalogue again.
      ...(hermesRunId || warmSelection ? {} : { modelCatalog: () => client.modelOptions() }),
      // Rejeu : un runtime `connector` qui annonce `features.event_replay` tient
      // un journal numéroté (docs/CONNECTOR.md). Keyed on the link instant, the
      // inventory fingerprint and the stored model, so consecutive turns on the
      // same link reuse the answer and skip the capabilities probe.
      ...(context.reachability === "connector"
        ? {
            replayCached: (inventory: Awaited<ReturnType<HermesClient["toolsets"]>>) => {
              const linkConnectedAt = linkInstant(context.linkConnectedAt);
              return client.peekCachedEventReplay({
                organizationId: context.organizationId,
                runtimeId: context.runtimeId,
                linkConnectedAt,
                toolsetFingerprint: hermesToolsetFingerprint(inventory),
                model: context.model,
              });
            },
            replayProbe: (inventory: Awaited<ReturnType<HermesClient["toolsets"]>>) => {
              const linkConnectedAt = linkInstant(context.linkConnectedAt);
              noteHermesPreflightLink({
                organizationId: context.organizationId,
                runtimeId: context.runtimeId,
                linkConnectedAt,
              });
              return client.eventReplaySupported({
                organizationId: context.organizationId,
                runtimeId: context.runtimeId,
                linkConnectedAt,
                toolsetFingerprint: hermesToolsetFingerprint(inventory),
                model: context.model,
              });
            },
          }
        : {}),
    });
    const memoryToolEnabled = toolsetInventory?.some((toolset) => toolset.name === "memory" && toolset.enabled) === true;
    context.memoryToolEnabled = memoryToolEnabled;
    // The web rule names `web_search` then `web_extract`: only a session
    // whose `web` toolset really announces both gets it.
    context.webToolsEnabled = toolsetInventory?.some((toolset) => toolset.name === "web" && toolset.enabled
      && toolset.tools?.includes("web_search") === true && toolset.tools.includes("web_extract")) === true;
    // La mémoire est celle du runtime : le bloc dit seulement au bot si son
    // outil `memory` existe dans cette session (toolset actif sur le profil).
    context.instructions = withBotModeInstructions(
      context.personaInstructions,
      buildRuntimeMemoryBlock({ toolEnabled: memoryToolEnabled }),
    );
    if (!hermesRunId) {
      // Tour de salon : entrée = le journal non lu du membre, attribué ; rien
      // de neuf → silence implicite, sans dépenser un appel à Hermes.
      const turn = groupSendState(context)
        ? await trace.span("preflight.group_turn", () => prepareGroupTurn(db, context, config.blob))
        : null;
      if (turn?.kind === "silent") {
        await completeGroupTurnWithoutHermes(db, config, context);
        return;
      }
      const selection = await takeWarmOrSelectModel(warmSelection, () => trace.span(
        "preflight.model_selection",
        () => resolveSelectionForNewRun(db, client, context, modelCatalog, warmModelKey),
      ));
      if (!selection) {
        await failWithoutUsableProvider(db, config, context);
        return;
      }
      const packed = isServiceStepKind(context.stepKind)
        ? { history: [] as Array<{ role: string; content: string }>, packInstructions: null }
        : turn
          ? await trace.span("preflight.history", () => packRoomHistory(db, {
              ...context,
              model: selection.model,
              provider: selection.provider,
              reasoningEffort: selection.reasoningEffort,
            }, turn, { client, signal: controller.signal }))
          : await trace.span("preflight.history", () => conversationHistory(db, {
              ...context,
              model: selection.model,
              provider: selection.provider,
              reasoningEffort: selection.reasoningEffort,
            }, { client, signal: controller.signal }));
      // Les instructions sont le PRÉFIXE que le fournisseur peut mettre en
      // cache : la part variable du cadrage (profondeur, budget restant) est
      // portée par l'entrée, jamais par elles. Le résumé vit dans
      // `conversation_history` ; les règles du pack, stables, rejoignent
      // le préfixe dès qu'un compact existe.
      const prompt: DmStepPrompt = isServiceStepKind(context.stepKind)
        ? {
            instructions: context.stepKind === "persona_draft"
              ? buildPersonaDraftInstructions(context.botName || "the new bot")
              : context.stepKind === "compaction"
                ? buildCompactionInstructions()
                : retiredServiceStep(context.stepKind),
            limitsLine: null,
          }
        : turn
          ? { instructions: turn.instructions, limitsLine: null }
          : await trace.span("preflight.instructions", () => dmInstructions(db, context));
      if (packed.packInstructions) {
        prompt.instructions = withBotModeInstructions(prompt.instructions, packed.packInstructions);
      }
      const routing = groupSendState(context)?.phase === "route";
      // L'apprentissage passe par les skills du runtime, jamais par une ligne
      // de mémoire : le bloc et la réécriture « /learn » n'existent que si
      // l'hôte annonce le toolset `skills` actif (bot-learning.ts).
      // Le routeur n'a pas d'outils : on ne lui annonce ni skills ni playbooks.
      const canLearn = !routing && !isServiceStepKind(context.stepKind) && runtimeCanLearn(toolsetInventory);
      if (!routing && (canLearn || (memoryToolEnabled && !isServiceStepKind(context.stepKind)))) {
        prompt.instructions = withBotModeInstructions(
          prompt.instructions,
          buildLearningBlock({ memoryToolEnabled }),
        );
      }
      const rawInput = canLearn && !turn && isLearnRequest(context.input) ? buildLearnInput(context.input) : context.input;
      const steppedInput = turn ? turn.input : withAutonomousStepLimits(rawInput, prompt.limitsLine);
      // La clé de run ne part qu'avec le bloc bot-mode qui annonce l'outil :
      // ni un tour de salon, ni une étape de workflow, ni un courrier entrant
      // ne la reçoivent, et l'API refuse de toute façon un bot non activé.
      const withRoutineKey = context.routineToolEnabled && prompt.instructions.includes(ROUTINE_TOOL_RUNTIME_NAME)
        ? withRoutineRunKey(steppedInput, signRoutineRunKey(config.apiInternalToken, context.id))
        : steppedInput;
      const input = context.botSettingsToolEnabled && prompt.instructions.includes(BOT_SETTINGS_TOOL_RUNTIME_NAME)
        ? withBotSettingsRunKey(withRoutineKey, signBotSettingsRunKey(config.apiInternalToken, context.id))
        : withRoutineKey;
      // Playbooks et « plan d'abord » dépendent du message : Hermes pose les
      // instructions en fin de prompt système, sous son point de cache, et
      // les y changer d'un tour à l'autre réécrivait tout le préfixe (outils
      // compris). Ils précèdent l'entrée, comme la ligne de limites.
      const turnScoped = !routing && !isServiceStepKind(context.stepKind);
      const playbooks = turnScoped
        ? await trace.span("preflight.playbooks", () => assignedPlaybookBlock(db, context, input))
        : "";
      const turnInput = withTurnGuidance(input, [turnScoped ? context.planTurnBlock : null, playbooks]);
      const creating = await trace.span("preflight.persist_model", () => persistResolvedRunModel(db, config, context, selection.model));
      if (!creating) return;
      activeContext.externalState = "creating";
      // Seul un workflow porte un budget de jetons : on n'ajoute cette lecture
      // qu'aux étapes qui la consomment, jamais aux DM ordinaires.
      if (context.workflowId) {
        activeContext.sessionCountersBefore = await trace.span(
          "preflight.session_counters",
          () => readWorkflowSessionCounters(activeContext, client, controller.signal),
        );
      }
      activeSelection = selection;
      retryState = {
        fallbackAttempted: false,
        extraModelTried: false,
        fromProvider: selection.provider,
        fallback: null,
      };
      // Les images du tour partent en parts `image_url`, dans la borne du
      // lien ; celle qui n'y tient pas est nommée au modèle, jamais tue.
      const turnImages = turn
        ? { images: turn.images, missing: [] }
        : isServiceStepKind(context.stepKind)
          ? { images: [], missing: [] }
          : await trace.span("preflight.images", () => loadRunImages(db, context, config.blob));
      const fitted = fitHermesRunImages({
        input: turnInput,
        images: turnImages.images,
        instructions: prompt.instructions,
        sessionId: context.sessionId,
        conversationHistory: packed.history,
      });
      const sentInput = [
        turnInput,
        ...turnImages.missing.map((name) => imageNotSentNote(name, "missing")),
        ...fitted.dropped.map((image) => imageNotSentNote(image.name, "too_large")),
      ].join("\n\n");
      runCreateArgs = { input: sentInput, images: fitted.images, instructions: prompt.instructions, history: packed.history };
      let createKey = context.id;
      while (!hermesRunId) {
        try {
          trace.mark("hermes.post_sent");
          hermesRunId = await client.createRun({
            input: sentInput,
            images: fitted.images,
            instructions: prompt.instructions,
            sessionId: context.sessionId,
            model: activeSelection.model,
            provider: activeSelection.provider,
            reasoningEffort: activeSelection.reasoningEffort,
            promptCacheTtl: context.promptCacheTtl,
            conversationHistory: packed.history,
            idempotencyKey: createKey,
            signal: controller.signal,
          });
        } catch (error) {
          const recovered = await recoverProviderFailure(
            db, config, client, context, error, activeSelection, retryState,
          );
          if (recovered.action === "auth_required") {
            throw fallbackAwareError(providerAuthRequiredError(recovered.provider), retryState);
          }
          if (recovered.action !== "retry") {
            throw fallbackAwareError(error, retryState);
          }
          activeSelection = recovered.selection;
          retryState = recovered.state;
          createKey = fallbackIdempotencyKey(context.id, retryState.extraModelTried);
          await db`
            update runs set model = ${activeSelection.model}, updated_at = now()
             where id = ${context.id} and organization_id = ${context.organizationId}
               and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
               and status = 'starting' and external_state = 'creating'
          `;
        }
      }
      trace.mark("hermes.run_created");
      context.provider = activeSelection.provider;
      context.model = activeSelection.model;
      const updated = await db<Array<{ id: string }>>`
        update runs set hermes_run_id = ${hermesRunId}, status = 'running', started_at = coalesce(started_at, now()),
          input = ${input}, external_state = 'streaming', events_complete = false, updated_at = now()
         where id = ${context.id} and organization_id = ${context.organizationId}
           and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
           and status = 'starting' and external_state = 'creating'
         returning id
      `;
      if (!updated[0]) {
        let remoteStopState: "confirmed" | "ambiguous" = "ambiguous";
        try {
          await client.stopRun(hermesRunId);
          remoteStopState = "confirmed";
        } catch (error) {
          log("worker.orphan_create_stop_unconfirmed", {
            runId: context.id,
            hermesRunId,
            error: describe(error),
          });
        }
        await db.begin(async (tx) => {
          const rows = await tx<Array<{ workflowId: string | null }>>`
            update runs set hermes_run_id = coalesce(hermes_run_id, ${hermesRunId}),
              status = 'unknown', external_state = ${remoteStopState === "confirmed" ? "polling" : "ambiguous"},
              remote_stop_state = ${remoteStopState}, events_complete = false,
              error_code = 'HERMES_CREATE_COMMIT_LOST',
              error_message = 'Hermes a créé le run mais le lease local a été perdu avant la confirmation.',
              lease_owner = null, lease_expires_at = null, ended_at = null, updated_at = now()
             where id = ${context.id} and organization_id = ${context.organizationId}
               and status in ('starting','running','awaiting_approval','unknown')
             returning workflow_id as "workflowId"
          `;
          if (rows[0]?.workflowId) await tx`
            update workflows set status = 'unknown', error_code = 'HERMES_CREATE_COMMIT_LOST',
              error_message = 'Le run Hermes existe mais sa création locale doit être réconciliée.',
              recovery_state = ${{
                runId: context.id,
                needsReview: true,
                action: "reconcile_or_abandon",
                hermesRunIdAvailable: true,
              }}, ended_at = null, updated_at = now()
             where organization_id = ${context.organizationId} and id = ${rows[0].workflowId}
               and status not in ('completed','failed','expired')
          `;
        });
        return;
      }
      activeContext.externalState = "streaming";
    } else {
      await settleResumedRunStatus(db, config, context);
    }

    // Rejeu : un runtime `connector` qui annonce `features.event_replay` tient
    // un journal numéroté (docs/CONNECTOR.md). On lui demande alors TOUJOURS
    // le flux par `?since=` : la numérotation du journal devient la nôtre, et
    // une rupture SSE se rattrape à la séquence exacte avant tout polling.
    // The probe started at the preflight gate; `hermes.replay_awaited` shows
    // whether the stream still had to wait for it.
    const replaySupported = await replayProbe;
    trace.mark("hermes.replay_awaited");
    trace.set("event_replay", replaySupported);
    if (activeContext.externalState === "polling") {
      if (!replaySupported || context.remoteStopState !== null) {
        trace.set("resume_mode", "status_polling");
        await reconcileHermesRun(db, config, activeContext, client, hermesRunId, controller.signal, trace);
        terminal = true;
        return;
      }
      // A known Hermes id can recover its uncommitted journal after a worker
      // restart. Only an announced, freshly gated replay capability permits
      // this transition; the create POST is never repeated.
      const resumed = await db<Array<{ id: string }>>`
        update runs set external_state = 'streaming', events_complete = false, updated_at = now()
         where id = ${context.id} and organization_id = ${context.organizationId}
           and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
           and hermes_run_id = ${hermesRunId} and external_state = 'polling'
           and remote_stop_state is null and status in ('running','awaiting_approval')
         returning id
      `;
      if (!resumed[0]) return;
      activeContext.externalState = "streaming";
      trace.set("resume_mode", "event_replay");
    }
    const sequenceRows = await db<Array<{ next: number }>>`
      select coalesce(max(sequence), -1) + 1 as next from run_events
       where organization_id = ${context.organizationId} and run_id = ${context.id}
    `;
    const nextSequence = Number(sequenceRows[0]?.next ?? 0);
    const priorToolRows = nextSequence > 0
      ? await db<Array<{ tool: string; toolCallId: string; unfinished: boolean }>>`
          select call_row.payload->>'tool' as tool, call_row.payload->>'toolCallId' as "toolCallId",
            not exists (
              select 1 from run_events result_row
               where result_row.organization_id = call_row.organization_id and result_row.run_id = call_row.run_id
                 and result_row.type = 'tool.result'
                 and result_row.payload->>'toolCallId' = call_row.payload->>'toolCallId'
            ) as unfinished
           from run_events call_row
          where call_row.organization_id = ${context.organizationId} and call_row.run_id = ${context.id}
            and call_row.type = 'tool.call' and call_row.payload->>'tool' is not null
            and call_row.payload->>'toolCallId' is not null
          order by call_row.sequence asc
        `
      : [];
    // Un worker repris doit restaurer les identifiants publiés et le FIFO des appels encore ouverts.
    const normalizer = new HermesEventNormalizer(nextSequence, {
      flushFirstDelta: true,
      priorToolCalls: priorToolRows.map((call) => ({
        tool: call.tool,
        toolCallId: call.toolCallId,
        completed: !call.unfinished,
      })),
    });
    let rawSequence = replaySupported ? context.lastHermesSequence : 0;
    let flushDeadline: number | null = null;
    let replayAttempts = 0;
    let replayGap = false;
    let restartAfterFallback = false;
    /** Set when the run's own provider refused its login: its `run.error` names it. */
    let authRequiredProvider: string | null = null;
    while (true) {
    const eventStreamController = new AbortController();
    const stopEventStream = () => eventStreamController.abort(controller.signal.reason);
    if (controller.signal.aborted) stopEventStream();
    else controller.signal.addEventListener("abort", stopEventStream, { once: true });
    const rawIterator = client.events(
      hermesRunId,
      eventStreamController.signal,
      {
        ...(replaySupported ? { since: rawSequence } : {}),
        // Over the relay this is time to first BYTE, not to the head: Bun.serve
        // (the API internal relay) sends a streamed response head with its first
        // body chunk, so it lands with `hermes.first_event` (OHB-137).
        onOpen: () => trace.mark("hermes.stream_open"),
      },
    )[Symbol.asyncIterator]();
    let nextRaw = rawIterator.next();
    let nativeTerminalSeen = false;
    try {
      while (true) {
        const wake = await waitForHermesEventOrFlush(
          nextRaw,
          flushDeadline === null ? null : flushDeadline - Date.now(),
        );
        if (wake.kind === "flush") {
          const buffered = normalizer.flush();
          flushDeadline = null;
          if (buffered.length > 0) {
            await persistEvents(db, config, context, rawSequence, buffered, client, trace);
          }
          continue;
        }
        if (wake.result.done) {
          // A closed relay socket can end cleanly at the HTTP body boundary.
          // Without a native terminal this is still an interrupted replay stream.
          if (replaySupported && !nativeTerminalSeen && !terminal && !controller.signal.aborted) {
            throw new HermesClientError("Le flux Hermes s’est fermé avant son événement terminal.", 502,
              "HERMES_STREAM_INTERRUPTED", { requestDelivery: "response_received" });
          }
          break;
        }
        const raw = wake.result.value;
        nextRaw = rawIterator.next();
        lastFrameAt = Date.now();
        trace.mark("hermes.first_event");
        if (raw.event === "message.delta") trace.mark("hermes.first_text_delta");
        // Un journal sans mémoire du run (`replay-gap`) repart de 1 : la
        // séquence recule, on ne sait plus ce qui manque, le polling tranche.
        const disposition = classifyHermesFrame(raw, {
          replaySupported,
          rawSequence,
          lastPersistedSequence: context.lastHermesSequence,
        });
        if (disposition.action === "gap") {
          replayGap = true;
          break;
        }
        rawSequence = disposition.rawSequence;
        if (disposition.action === "skip") continue;
        nativeTerminalSeen ||= raw.event === "run.completed" || raw.event === "run.failed"
          || raw.event === "run.error" || raw.event === "run.cancelled" || raw.event === "run.interrupted";
        if (raw.event === "run.steered" && typeof raw.accepted === "boolean") {
          await reconcileRunSteerEvent(db, {
            id: context.id,
            organizationId: context.organizationId,
          }, raw.accepted);
        }
        // Le texte amont d'un échec quitte le fil (voir `hermesRunFailure`) :
        // le journal du worker devient le seul endroit où le lire.
        if (raw.event === "run.failed" || raw.event === "run.error") {
          log("worker.hermes_run_failure_upstream", {
            runId: context.id,
            organizationId: context.organizationId,
            upstream: describe(raw.message ?? raw.error ?? null),
          });
          if (runCreateArgs && activeSelection && !controller.signal.aborted) {
            // Text the failed attempt already streamed is persisted first, so
            // the fallback notice is numbered after it and nothing is
            // reordered or merged into the next attempt's answer.
            const pending = normalizer.flush();
            flushDeadline = null;
            // Its watermark stops before the failure frame, still unhandled.
            if (pending.length > 0) await persistEvents(db, config, context, Math.max(0, rawSequence - 1), pending, client, trace);
            const recovered = await recoverProviderFailure(
              db, config, client, context, raw, activeSelection, retryState,
            );
            if (recovered.action === "auth_required") authRequiredProvider = recovered.provider;
            if (recovered.action === "retry") {
              normalizer.skipPast(recovered.fallbackSequence);
              activeSelection = recovered.selection;
              retryState = recovered.state;
              const nextId = await client.createRun({
                input: runCreateArgs.input,
                images: runCreateArgs.images,
                instructions: runCreateArgs.instructions,
                sessionId: context.sessionId,
                model: activeSelection.model,
                provider: activeSelection.provider,
                reasoningEffort: activeSelection.reasoningEffort,
                promptCacheTtl: context.promptCacheTtl,
                conversationHistory: runCreateArgs.history,
                idempotencyKey: fallbackIdempotencyKey(context.id, retryState.extraModelTried),
                signal: controller.signal,
              });
              hermesRunId = nextId;
              await db`
                update runs set hermes_run_id = ${nextId}, model = ${activeSelection.model},
                  status = 'running', external_state = 'streaming', events_complete = false, updated_at = now()
                 where id = ${context.id} and organization_id = ${context.organizationId}
                   and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
                   and status in ('starting','running','awaiting_approval')
              `;
              context.provider = activeSelection.provider;
              context.model = activeSelection.model;
              rawSequence = 0;
              replayAttempts = 0;
              replayGap = false;
              restartAfterFallback = true;
              break;
            }
          }
        }
        let events = normalizer.push(raw);
        if (authRequiredProvider) {
          const payload = providerAuthRequiredPayload(authRequiredProvider);
          events = events.map((event) => event.type === "run.error" ? { ...event, payload } : event);
        }
        // Le SSE ne porte ni les arguments d'un outil ni son résultat. Dès
        // qu'une écriture `todo` ou une recherche web se termine, le
        // transcript est à jour : on relit, on projette, et on rattache. Ce
        // sont des états observés, jamais une progression simulée.
        //
        // Un `run.completed` qui porte déjà `messages` n'a rien à faire
        // relire : c'est le transcript AUTORITATIF DU TOUR, et le normaliseur
        // en a tiré plan et recherches. Relire la session par-dessus ne
        // ferait qu'y ramasser les tours précédents. La relecture reste donc
        // le chemin des projections en cours de run, et le repli d'un gateway
        // qui n'enverrait pas ce champ.
        const turnTranscript = Array.isArray(raw.messages) && raw.messages.length > 0
          ? raw.messages as unknown[]
          : null;
        const transcriptEventType = raw.event === "run.completed"
          ? (turnTranscript ? null : "run.completed")
          : raw.event === "tool.completed" && typeof raw.tool === "string" &&
            (TRANSCRIPT_TOOLS.has(raw.tool) || isTodoTool(raw.tool) || raw.error === true)
            ? "tool.result"
            : null;
        let reReadTurn: unknown[] | null = null;
        if (transcriptEventType && events.some((event) => event.type === transcriptEventType)) {
          const { agentPlan, webSearch, turn } = await readAgentTranscript(context, client);
          reReadTurn = turn;
          if (agentPlan || webSearch) {
            events = events.map((event) => event.type === transcriptEventType
              ? {
                  ...event,
                  payload: {
                    ...event.payload,
                    ...(agentPlan ? { agentPlan } : {}),
                    ...(webSearch ? { webSearch } : {}),
                  },
                }
              : event);
          }
        }
        // Le transcript du tour porte les arguments d'écriture. On le pose
        // sur l'événement le temps de `persistEvents`, qui le retire avant
        // l'insert : le journal SSE ne doit pas embarquer le HTML entier.
        if (raw.event === "run.completed") {
          const turnMessages = turnTranscript ?? reReadTurn;
          if (Array.isArray(turnMessages) && turnMessages.length > 0) {
            events = events.map((event) => event.type === "run.completed"
              ? { ...event, payload: { ...event.payload, turnMessages } }
              : event);
            events.push(...normalizer.attachToolResults(turnMessages));
          }
        }
        if (raw.event === "tool.completed" && raw.error === true && reReadTurn) {
          const tool = typeof raw.tool === "string" ? raw.tool : null;
          if (tool) {
            const projected = projectToolResults(reReadTurn).filter((entry) => entry.tool === tool);
            const upstreamCallId = typeof (raw as unknown as Record<string, unknown>).tool_call_id === "string"
              ? String((raw as unknown as Record<string, unknown>).tool_call_id)
              : null;
            const transcriptResult = (upstreamCallId
              ? projected.find((entry) => entry.callId === upstreamCallId)
              : null) ?? projected[projected.length - 1];
            if (transcriptResult?.errorMessage) {
              events = events.map((event) => event.type === "tool.result" && event.payload.tool === tool &&
                !event.payload.errorMessage
                ? { ...event, payload: { ...event.payload, errorMessage: transcriptResult.errorMessage } }
                : event);
            }
          }
        }
        // Ce que le modèle avait RÉELLEMENT en main à la fin du tour : ce qui
        // lui a été envoyé, plus ce que le tour a fait pousser (appels d'outils
        // et résultats). Aucun appel réseau de plus : l'envoi vient de
        // `runCreateArgs`, le transcript du tour du SSE lui-même.
        if (raw.event === "run.completed" && runCreateArgs) {
          const contextUsage = readContextUsage({
            instructions: runCreateArgs.instructions,
            history: runCreateArgs.history,
            input: runCreateArgs.input,
            turnMessages: turnTranscript ?? reReadTurn,
          });
          if (contextUsage) {
            events = events.map((event) => event.type === "run.completed"
              ? { ...event, payload: { ...event.payload, contextUsage } }
              : event);
          }
        }
        if (normalizer.hasBufferedDelta) flushDeadline ??= Date.now() + DELTA_FLUSH_MS;
        else flushDeadline = null;
        if (events.length > 0) {
          terminal = terminal || events.some((event) => event.type === "run.completed" || event.type === "run.error");
          await persistEvents(db, config, context, rawSequence, events, client, trace);
          if (events.some((event) => event.type === "approval.requested")) {
            void forwardReadyApprovals().catch((error) => {
              log("worker.approval_forward_failed", {
                runId: activeContext.id,
                errorCode: approvalForwardErrorCode(error),
              });
            });
          }
          // Les steers que l'agent n'a jamais lus reviennent sur le terminal :
          // ils redeviennent des tours, une fois ce run réglé.
          if (raw.event === "run.completed") {
            await replayUndeliveredRunSteersSafely(db, context, pendingSteerOf(raw.pending_steer));
          }
        } else if (!normalizer.hasBufferedDelta) {
          // Un delta tamponné n'est pas encore durable. Avancer son watermark
          // séparément obligerait une écriture PostgreSQL par fragment et,
          // après crash, ferait sauter du texte jamais persisté. Le flush
          // groupe texte et watermark dans la même transaction.
          await db`
            update runs set last_hermes_sequence = ${rawSequence}, updated_at = now()
             where id = ${context.id} and organization_id = ${context.organizationId}
               and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
            `;
        }
      }
    } catch (error) {
      if (
        replaySupported && !replayGap && replayAttempts < MAX_EVENT_REPLAY_ATTEMPTS &&
        !controller.signal.aborted && isReplayableStreamFailure(error)
      ) {
        replayAttempts += 1;
        log("worker.hermes_stream_replay", {
          runId: context.id,
          organizationId: context.organizationId,
          attempt: replayAttempts,
          since: rawSequence,
          code: error.code,
        });
        await pollWait(eventReplayDelayMs(replayAttempts), controller.signal);
        continue;
      }
      throw error;
    } finally {
      // `for await` faisait cette fermeture implicitement. Le loop temporel
      // est manuel : sur erreur DB/annulation il doit rendre le reader SSE,
      // sinon une lecture `next()` peut rester vivante hors du run.
      eventStreamController.abort("stream_consumer_closed");
      controller.signal.removeEventListener("abort", stopEventStream);
      await rawIterator.return?.(undefined).catch(() => undefined);
    }
    if (restartAfterFallback) {
      restartAfterFallback = false;
      continue;
    }
    break;
    }
    if (replayGap) {
      log("worker.hermes_stream_replay_gap", { runId: context.id, organizationId: context.organizationId, since: rawSequence });
    }
    const tail = normalizer.flush();
    if (tail.length > 0) await persistEvents(db, config, context, rawSequence, tail, client, trace);
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
      cancelRequested = true;
      activeContext.remoteStopState = "requested";
      activeContext.errorCode = stopRows[0].errorCode;
      activeContext.errorMessage = stopRows[0].errorMessage;
      await processRequestedCancellation(db, config, activeContext, client, hermesRunId);
      terminal = true;
      return;
    }
    if (!terminal && !controller.signal.aborted) {
      await db`
        update runs set external_state = 'polling', events_complete = false, updated_at = now()
         where id = ${context.id} and organization_id = ${context.organizationId}
           and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
      `;
      activeContext.externalState = "polling";
      await reconcileHermesRun(db, config, activeContext, client, hermesRunId, controller.signal, trace);
      terminal = true;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      // Un abort d'inactivité fait échouer le run (retryable); les autres (shutdown,
      // perte de bail, annulation) laissent la reprise à la file.
      if (cancelRequested) {
        await processRequestedCancellation(db, config, activeContext, client, hermesRunId);
      } else if (approvalExpired) {
        // PERM2-9: the three named outcomes of a gate nobody answered are a
        // refusal (on the gate), `APPROVAL_EXPIRED` once the stop is
        // reconciled, `APPROVAL_EXPIRY_STOP_OUTCOME_UNKNOWN` when it is not.
        if (hermesRunId) {
          await stopAndReconcileAfterAbort(
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
      } else if (idleTimedOut || runTimedOut) {
        if (!hermesRunId) {
          const createWasDefinitelyNotSent = error instanceof HermesClientError && error.requestDelivery === "not_sent";
          if (activeContext.externalState === "creating" && !createWasDefinitelyNotSent) {
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
          hermesRunId,
          "HERMES_STOP_OUTCOME_UNKNOWN",
          "L’arrêt Hermes n’a pas pu être confirmé.",
        );
      }
      return;
    }
    if (
      hermesRunId && error instanceof HermesClientError &&
      ["HERMES_STREAM_INTERRUPTED", "HERMES_PROTOCOL_LIMIT", "HERMES_UNREACHABLE"].includes(error.code)
    ) {
      await db`
        update runs set external_state = 'polling', events_complete = false,
          error_code = ${error.code}, error_message = ${error.message}, updated_at = now()
         where id = ${context.id} and organization_id = ${context.organizationId}
           and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
      `;
      activeContext.externalState = "polling";
      // The link failed during the resume itself, before the run left
      // `starting`: an open gate must still read `awaiting_approval`, or the
      // heartbeat never forwards its answer and Hermes stays parked at it.
      await settleResumedRunStatus(db, config, context);
      await reconcileHermesRun(db, config, activeContext, client, hermesRunId, controller.signal, trace);
      return;
    }
    await handleFailure(db, config, context, fallbackAwareError(error, retryState));
  } finally {
    clearInterval(runSteerPoll);
    runSteerController.abort("run_finished");
    const pendingRunSteer = runSteerPollPromise as Promise<void> | null;
    if (pendingRunSteer) await pendingRunSteer.catch(() => undefined);
    controller.signal.removeEventListener("abort", stopRunSteer);
    clearTimeout(runTimeout);
    clearInterval(heartbeat);
    shutdownSignal?.removeEventListener("abort", stopForExternalSignal);
  }
}

/**
 * Reprise après perte de bail : une gate encore ouverte garde le run en
 * `awaiting_approval`. Repasser en `running` cachait la gate à l'API (le clic
 * l'expirait comme inactive) et au heartbeat, qui ne transmettait plus la
 * réponse. Sans effet hors de `starting` : un run déjà réattaché garde son état.
 */
async function settleResumedRunStatus(db: SQL, config: WorkerConfig, context: RunContext): Promise<void> {
  await db`
    update runs set
      status = case when exists (
        select 1 from approval_requests gate
         where gate.organization_id = runs.organization_id and gate.run_id = runs.id
           and gate.status in ('pending','approved','denied')
           and gate.forward_state in ('pending','ready','sending')
      ) then 'awaiting_approval' else 'running' end,
      external_state = case when external_state = 'polling' then 'polling' else 'streaming' end,
      events_complete = false, updated_at = now()
     where id = ${context.id} and organization_id = ${context.organizationId}
       and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
       and status = 'starting'
  `;
}

/**
 * Expire atomiquement une gate restée sans réponse. Le worker vivant appelle
 * ceci avant de renouveler son bail : une approbation ne peut donc pas garder
 * un fil actif indéfiniment simplement parce que le heartbeat fonctionne.
 */
async function expirePendingApprovalTx(
  tx: SQL,
  organizationId: string,
  runId: string,
): Promise<boolean> {
  const rows = await tx<Array<{ id: string }>>`
    with newly_expired as (
      update approval_requests set status = 'expired', resolved_at = now()
       where organization_id = ${organizationId} and run_id = ${runId}
         and status = 'pending' and expires_at <= now()
       returning id
    )
    select id from newly_expired
    union all
    select id from approval_requests
     where organization_id = ${organizationId} and run_id = ${runId}
       and status = 'expired' and selected_choice is null
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Silence implicite : rien de neuf pour ce membre. On termine le run par un
 * run.completed synthétique SANS sortie, via persistEvents : le fil voit la
 * fin du run, l'avis de pass, et l'envoi avance, exactement comme un `pass`
 * répondu par Hermes.
 */
async function completeGroupTurnWithoutHermes(db: SQL, config: WorkerConfig, context: RunContext): Promise<void> {
  const sequenceRows = await db<Array<{ next: number }>>`
    select coalesce(max(sequence), -1) + 1 as next from run_events
     where organization_id = ${context.organizationId} and run_id = ${context.id}
  `;
  await persistEvents(db, config, context, context.lastHermesSequence, [{
    sequence: Number(sequenceRows[0]?.next ?? 0),
    type: "run.completed",
    occurredAt: new Date(),
    payload: { output: "" },
  }]);
}
