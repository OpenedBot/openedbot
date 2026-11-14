import type { SQL } from "bun";
import { type HermesClient, HermesClientError } from "@openedbot/hermes";
import type { GateIdentity } from "../../domain/gate-identity";
import { ACTIVE_RUN_STATUSES } from "../../domain/run-transitions";
import { RELEASE_LEASE, transitionRuns } from "../../sql/run-transitions";
import type { WorkerConfig } from "../worker-config";
import { markRunUnknown } from "./failure";
import { reconcileHermesRun } from "./reconcile";
import { resumeAfterApproval, runKey } from "./lease-transitions";
import { checkBeforeForwardTx } from "./permission-gate";
import { lockWorkflowTx, permissionRuleSourceFor } from "./permission-rule-sources";
import type { RunState } from "./run-state";
import type { RunContext } from "./types";
import { log } from "./util";

type ClaimedApproval = {
  id: string;
  choice: "once" | "deny";
  forwardingEpoch: number;
  hermesRequestId: string | null;
  /** Hermes 0.23 turn of the gate; null for a Hermes 0.22 gate or a row from before 0182. */
  hermesExecutionGeneration: number | string | null;
};

/**
 * Approbations: forwards the oldest decided gate of the run to Hermes, once.
 * The claim re-checks the decision under the run's lock (PERM2-1), the
 * answer is confirmed under the run's and the workflow's locks, and an
 * outcome Hermes may have received but nobody confirmed is never sent again.
 * Reads `state.hermesRunId`; writes `state.lastFrameAt` and aborts
 * `state.controller` when the outcome is ambiguous.
 */
export async function forwardReadyApproval(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
): Promise<void> {
  if (!state.hermesRunId) return;
  // Appelé toutes les RUN_STEER_POLL_MS : une lecture simple écarte le cas
  // courant (rien de prêt) avant la transaction et ses verrous sur le run.
  const ready = await db<Array<{ one: number }>>`
    select 1 as one from approval_requests
     where organization_id = ${context.organizationId} and run_id = ${context.id}
       and selected_choice is not null and forward_state = 'ready'
     limit 1
  `;
  if (!ready[0]) return;
  // PERM2-9: "Never wait" through the port, resolved before the locks.
  const unattendedFrom = await permissionRuleSourceFor(context.organizationId);
  const approvals = await db.begin(async (tx) => {
    const run = await tx<Array<{ workflowId: string | null }>>`
      select workflow_id as "workflowId" from runs
       where organization_id = ${context.organizationId} and id = ${context.id}
         and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
         and status = 'awaiting_approval'
       for update
    `;
    if (!run[0]) return [];
    const neverWait = await lockWorkflowTx(tx as unknown as SQL, context.organizationId, run[0].workflowId, unattendedFrom);
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
      hermesExecutionGeneration: number | string | null;
      choices: unknown;
      detail: Record<string, unknown> | null;
    }>>`
      select id, selected_choice as choice, decided_by_kind as "decidedByKind",
             permission_revision_seen as "revisionSeen", gate_kind as "gateKind", tool_key as "toolKey",
             gate_args as "gateArgs", descriptor_version as "descriptorVersion",
             hermes_request_id as "hermesRequestId", hermes_execution_generation as "hermesExecutionGeneration",
             choices, decision_detail as detail
        from approval_requests
       where organization_id = ${context.organizationId} and run_id = ${context.id}
         and selected_choice is not null and forward_state = 'ready'
       order by gate_ordinal asc limit 1
       for update skip locked
    `;
    const candidate = candidates[0];
    if (!candidate) return [];
    // PERM2-1, the linearization point of a `v2` decision: the bot's
    // revision is read again here, `for share`, under this claim.
    const check = await checkBeforeForwardTx(tx as unknown as SQL, {
      organizationId: context.organizationId,
      botId: context.botId,
      neverWait,
      planOnly: context.planOnly === true,
    }, {
      choice: candidate.choice,
      decidedByKind: candidate.decidedByKind,
      revisionSeen: candidate.revisionSeen,
      gate: {
        hermesRequestId: candidate.hermesRequestId,
        hermesExecutionGeneration: candidate.hermesExecutionGeneration === null ? null : Number(candidate.hermesExecutionGeneration),
        gateKind: candidate.gateKind, toolKey: candidate.toolKey,
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
      log("approval.decision", { runId: context.id, stage: redone.decision.stage, outcome: redone.choice ?? "deny", reason: redone.choice ? redone.decision.reason : "policy_changed", redecided: true });
    }
    const rows = await tx<ClaimedApproval[]>`
      update approval_requests set forward_state = 'sending',
        forwarding_owner = ${config.workerId}, forwarding_epoch = forwarding_epoch + 1,
        forwarding_lease_expires_at = now() + (${config.leaseSeconds} * interval '1 second'),
        selected_choice = ${choice}, status = ${choice === "deny" ? "denied" : "approved"},
        decision_stage = coalesce(${rewrite?.stage ?? null}, decision_stage),
        permission_revision_seen = coalesce(${rewrite?.revision ?? null}, permission_revision_seen),
        decision_detail = coalesce(${rewrite?.detail ?? null}, decision_detail),
        resolved_by_policy = case when decided_by_kind = 'policy'
          then coalesce(${rewrite?.policy ?? null}, resolved_by_policy) else resolved_by_policy end
       where id = ${candidate.id} and organization_id = ${context.organizationId}
      returning id, selected_choice as choice,
        forwarding_epoch as "forwardingEpoch", hermes_request_id as "hermesRequestId",
        hermes_execution_generation as "hermesExecutionGeneration"
    `;
    return rows;
  }) as ClaimedApproval[];
  const approval = approvals[0];
  if (!approval) return;
  const { controller } = state;
  try {
    // PERM2-A: the exact gate when Hermes named it; positional otherwise
    // (a runtime older than `request_id`, or a row from before 0137).
    // The id is read at send time, as the closure did before S2e: a provider
    // fallback started since the guard above may have replaced it (or reset
    // it to null while it creates). Kept as is, noted in 0002 section 9.4.
    const generation = approval.hermesExecutionGeneration === null ? null : Number(approval.hermesExecutionGeneration);
    await client.respondApproval(state.hermesRunId as string, approval.choice, controller.signal, approval.hermesRequestId, generation);
    const confirmed = await db.begin(async (tx) => {
      const run = await tx<Array<{ workflowId: string | null; status: string }>>`
        select workflow_id as "workflowId", status from runs
         where id = ${context.id} and organization_id = ${context.organizationId}
         for update
      `;
      const workflow = run[0]?.workflowId
        ? (await tx<Array<{ status: string }>>`
            select status from workflows
             where organization_id = ${context.organizationId} and id = ${run[0].workflowId}
             for update
          `)[0]
        : null;
      const gates = await tx<Array<{ id: string }>>`
        update approval_requests set forwarded_at = now(), forward_state = 'confirmed',
          forwarding_owner = null, forwarding_lease_expires_at = null
         where id = ${approval.id} and organization_id = ${context.organizationId}
           and forward_state = 'sending' and forwarding_owner = ${config.workerId}
           and forwarding_epoch = ${approval.forwardingEpoch}
        returning id
      `;
      const fenced = run[0] && ["starting", "running", "awaiting_approval"].includes(run[0].status);
      if (!fenced || !gates[0]) {
        await tx`
          update approval_requests set forward_state = 'ambiguous', forwarding_owner = null,
            forwarding_lease_expires_at = null
           where id = ${approval.id} and organization_id = ${context.organizationId}
             and forward_state <> 'confirmed'
        `;
        // Unleased on purpose: the decision reached Hermes whoever holds the run now.
        await transitionRuns(tx as unknown as SQL, {
          target: runKey(context), fence: "unleased",
          transition: {
            from: [...ACTIVE_RUN_STATUSES, "cancelled"],
            to: { status: "unknown", externalState: "ambiguous", remoteStopState: { map: { requested: "ambiguous" } } },
          },
          set: {
            eventsComplete: false, errorCode: "APPROVAL_FORWARD_OUTCOME_UNKNOWN",
            errorMessage: "Hermes a reçu la décision mais sa confirmation locale a été perdue.", ...RELEASE_LEASE, endedAt: null,
          },
        });
        if (run[0]?.workflowId) await tx`
          update workflows set status = 'unknown', error_code = 'APPROVAL_FORWARD_OUTCOME_UNKNOWN',
            error_message = 'Hermes a reçu la décision mais sa confirmation locale a été perdue.',
            recovery_state = ${{ runId: context.id, needsReview: true }}, ended_at = null, updated_at = now()
           where organization_id = ${context.organizationId} and id = ${run[0].workflowId}
             and status not in ('completed','failed','expired')
        `;
        return false;
      }
      await resumeAfterApproval(tx as unknown as SQL, config, context);
      if (context.workflowId && workflow) await tx`
        update workflows set status = 'running', updated_at = now()
         where organization_id = ${context.organizationId} and id = ${context.workflowId}
           and status = 'awaiting_approval'
      `;
      return true;
    });
    if (!confirmed) controller.abort("approval_forward_ambiguous");
    // Une approbation peut rester légitimement ouverte au-delà du timeout
    // d'inactivité. Sa transmission est une activité : le flux repart de zéro
    // au lieu d'être avorté au heartbeat suivant avec l'ancienne horloge.
    state.lastFrameAt = Date.now();
  } catch (error) {
    const safe = error instanceof HermesClientError && error.requestDelivery === "not_sent";
    if (safe) {
      await db`
        update approval_requests set forward_state = 'ready', forwarding_owner = null,
          forwarding_lease_expires_at = null
         where id = ${approval.id} and organization_id = ${context.organizationId}
           and forward_state = 'sending' and forwarding_owner = ${config.workerId}
           and forwarding_epoch = ${approval.forwardingEpoch}
      `;
    } else {
      await db`
        update approval_requests set forward_state = 'ambiguous', forwarding_owner = null,
          forwarding_lease_expires_at = null
         where id = ${approval.id} and organization_id = ${context.organizationId}
           and forward_state = 'sending' and forwarding_owner = ${config.workerId}
           and forwarding_epoch = ${approval.forwardingEpoch}
      `;
      if (await settledAsLostTurn(db, config, context, client, state, approval, error)) {
        controller.abort("approval_forward_turn_lost");
        return;
      }
      await markRunUnknown(db, config, context, "APPROVAL_FORWARD_OUTCOME_UNKNOWN",
        "Hermes a pu recevoir la décision d’autorisation; aucune retransmission automatique.");
      controller.abort("approval_forward_ambiguous");
    }
  }
}

/**
 * Hermes 0.23 refused the answer (a 404 or 409 it did send) for a gate of a
 * turn its process lost: the run is `unknown` upstream, so the decision was
 * certainly not applied. Reconciliation then resolves the turn, so the
 * session's next turns can start, and records the run as interrupted instead
 * of "outcome unknown". Any other case keeps the ambiguous path.
 */
async function settledAsLostTurn(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  approval: ClaimedApproval,
  error: unknown,
): Promise<boolean> {
  if (approval.hermesExecutionGeneration === null || !state.hermesRunId) return false;
  if (!(error instanceof HermesClientError) || error.requestDelivery !== "response_received") return false;
  if (error.status !== 404 && error.status !== 409) return false;
  try {
    const details = await client.getRunStatus(state.hermesRunId, state.controller.signal);
    if (details.status !== "unknown") return false;
    log("approval.forward_turn_lost", { runId: context.id, status: error.status });
    await reconcileHermesRun(db, config, context, client, state.hermesRunId, state.controller.signal);
    return true;
  } catch {
    return false;
  }
}

export const approvalForwardErrorCode = (error: unknown) =>
  error instanceof HermesClientError ? error.code : "APPROVAL_FORWARD_FAILED";

/**
 * Expire atomiquement une gate restée sans réponse. Le worker vivant appelle
 * ceci avant de renouveler son bail : une approbation ne peut donc pas garder
 * un fil actif indéfiniment simplement parce que le heartbeat fonctionne.
 */
export async function expirePendingApprovalTx(
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
