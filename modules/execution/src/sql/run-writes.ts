import type { SQL } from "bun";
import {
  newRunViolation,
  newWorkflowViolation,
  type NewRootRun,
  type NewRun,
  type NewWorkflow,
} from "../domain/run-creation";

/**
 * The only physical writes that create runs and workflows.
 * Private to the creation commands: `application/run-creation.ts` and
 * `application/runner/workflow-steps.ts` import this file, nothing else does
 * (dependency-cruiser `primitives-de-creation-privees`), and no other file
 * writes `insert into runs` / `insert into workflows` or claims a workflow
 * step (`tests/scripts/run-writes-contract.ts`).
 *
 * Each statement lists every column it writes, one placeholder per column, in
 * the order of the column list.
 */

function refuse(kind: string, violation: string, id: string): never {
  throw new Error(`${kind} ${id} refused before writing: ${violation}`);
}

/** Inserts one run. Its shape is checked first (`newRunViolation`). */
export async function insertRunTx(tx: SQL, run: NewRun): Promise<void> {
  const violation = newRunViolation(run);
  if (violation) refuse("run", violation, run.id);
  await tx`
    insert into runs (
      id, organization_id, thread_id, bot_id, input, status, model,
      group_turn_position, group_state, workflow_id, step_index, step_kind, stack_depth,
      caller_bot_id, caller_run_id, resumes_run_id, completion_kind, execution_session_key,
      initiator_user_id, origin, plan_only, user_time_zone, source_message_id, origin_run_id, handoff_target_bot_id,
      external_state, events_complete, deadline_at
    ) values (
      ${run.id}, ${run.organizationId}, ${run.threadId}, ${run.botId}, ${run.input}, ${run.status}, ${run.model},
      ${run.groupTurnPosition}, ${run.groupState}, ${run.workflowId}, ${run.stepIndex}, ${run.stepKind}, ${run.stackDepth},
      ${run.callerBotId}, ${run.callerRunId}, ${run.resumesRunId}, ${run.completionKind}, ${run.executionSessionKey},
      ${run.initiatorUserId}, ${run.origin}, ${run.planOnly}, ${run.userTimeZone}, ${run.sourceMessageId}, ${run.originRunId},
      ${run.handoffTargetBotId}, ${"not_started"}, ${true},
      now() + (${run.deadlineSeconds}::integer * interval '1 second')
    )
  `;
}

/**
 * Opens a workflow and inserts its root run, workflow first, in the caller's
 * transaction. The budget is frozen as given; `used_steps = 1` counts the root.
 */
export async function openWorkflowTx(tx: SQL, workflow: NewWorkflow, root: NewRootRun): Promise<void> {
  const violation = newWorkflowViolation(workflow, root);
  if (violation) refuse("workflow", violation, workflow.id);
  const run: NewRun = { ...root, status: "queued", workflowId: workflow.id, stepIndex: 0 };
  const runViolation = newRunViolation(run);
  if (runViolation) refuse("run", runViolation, run.id);
  const budget = workflow.budget;
  await tx`
    insert into workflows (
      id, organization_id, thread_id, root_run_id, root_bot_id, initiator_user_id, kind, status,
      protocol_version, autonomy_enabled, max_depth, max_steps, max_handoffs, timeout_seconds, token_budget,
      used_steps, used_handoffs, used_tokens, recovery_state, plan_only, never_wait, deadline_at
    ) values (
      ${workflow.id}, ${run.organizationId}, ${run.threadId}, ${run.id}, ${workflow.rootBotId},
      ${workflow.initiatorUserId}, ${workflow.kind}, ${"queued"},
      ${workflow.protocolVersion}, ${budget.enabled}, ${budget.maxDepth}, ${budget.maxSteps},
      ${budget.maxHandoffs}, ${budget.timeoutSeconds}, ${budget.tokenBudget},
      ${1}, ${workflow.usedHandoffs}, ${0}, ${workflow.recoveryState}, ${workflow.planOnly}, ${workflow.neverWait},
      now() + (${budget.timeoutSeconds}::integer * interval '1 second')
    )
  `;
  await insertRunTx(tx, run);
}

/**
 * Counts one more step (and, for a delegation, one more handoff) on the
 * locked workflow of the step just inserted, and marks it running. The budget
 * constraints of `workflows` refuse an overrun the caller must have ruled out.
 */
export async function claimWorkflowStepTx(
  tx: SQL,
  step: { organizationId: string; workflowId: string; handoff: boolean },
): Promise<void> {
  if (step.handoff) {
    await tx`
      update workflows set status = 'running', used_steps = used_steps + 1,
        used_handoffs = used_handoffs + 1, updated_at = now()
       where organization_id = ${step.organizationId} and id = ${step.workflowId}
    `;
    return;
  }
  await tx`
    update workflows set status = 'running', used_steps = used_steps + 1, updated_at = now()
     where organization_id = ${step.organizationId} and id = ${step.workflowId}
  `;
}
