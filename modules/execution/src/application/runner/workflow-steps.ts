import type { SQL } from "bun";
import { workflowSessionKey } from "@openedbot/roster/domain/autonomous-workflow";
import { queuedRun } from "../../domain/run-creation";
import { claimWorkflowStepTx, insertRunTx } from "../../sql/run-writes";

/**
 * The runs the worker creates while it settles a step, in the transaction of
 * `persistEvents` (or of the poison reaper), under the lock of the current run
 * and of its workflow. Built on the private primitives
 * of `sql/run-writes.ts`, like the admission commands of `run-creation.ts`.
 *
 * Numbers in brackets are the creation sites of the inventory (0002, 3.1).
 */

type StepPlace = { organizationId: string; threadId: string; workflowId: string; stepIndex: number };

/** The next speaker of a room send: the turn carries the send state, its input is the room itself. */
export type GroupStep = StepPlace & { kind: "group"; botId: string; groupTurnPosition: number | null; groupState: unknown };

/** A delegation accepted by `canDelegate`: the target answers in the workflow's session, one level deeper. */
export type DelegatedStep = StepPlace & {
  kind: "delegated";
  botId: string;
  input: string;
  stackDepth: number;
  callerBotId: string;
  callerRunId: string;
};

/** The caller resuming after a delegated step's result or known failure. */
export type ContinuationStep = StepPlace & {
  kind: "continuation";
  botId: string;
  input: string;
  stackDepth: number;
  callerBotId: string | null;
  callerRunId: string | null;
  resumesRunId: string | null;
  completionKind: string;
};

/**
 * [10, 14, 15] The next step of a workflow the caller holds locked: one run
 * at `stepIndex`, then one more step (and, for a delegation, one more handoff)
 * on the workflow, which is now running. Returns the new run.
 */
export async function startWorkflowStepTx(tx: SQL, step: GroupStep | DelegatedStep | ContinuationStep): Promise<string> {
  const id = crypto.randomUUID();
  const place = { id, organizationId: step.organizationId, threadId: step.threadId, botId: step.botId };
  const located = { workflowId: step.workflowId, stepIndex: step.stepIndex, stepKind: step.kind };
  if (step.kind === "group") {
    await insertRunTx(tx, queuedRun({ ...place, input: "" }, {
      ...located, stackDepth: 0, groupTurnPosition: step.groupTurnPosition, groupState: step.groupState,
    }));
  } else {
    await insertRunTx(tx, queuedRun({ ...place, input: step.input }, {
      ...located,
      stackDepth: step.stackDepth,
      callerBotId: step.callerBotId,
      callerRunId: step.callerRunId,
      ...(step.kind === "continuation"
        ? { resumesRunId: step.resumesRunId, completionKind: step.completionKind }
        : {}),
      executionSessionKey: workflowSessionKey(step.organizationId, step.workflowId, step.botId),
    }));
  }
  await claimWorkflowStepTx(tx, {
    organizationId: step.organizationId,
    workflowId: step.workflowId,
    handoff: step.kind === "delegated",
  });
  return id;
}

/**
 * [10 without workflow, 11, 16] The next member of a room turn created before
 * room workflows: no workflow, no step kind, no envelope (inventory D8, D11).
 * Kept until the legacy rows are counted in production and drained.
 */
export async function chainLegacyRoomTurnTx(
  tx: SQL,
  turn: { organizationId: string; threadId: string; botId: string; groupTurnPosition: number | null; input: string; groupState: unknown },
): Promise<void> {
  await insertRunTx(tx, queuedRun(
    { id: crypto.randomUUID(), organizationId: turn.organizationId, threadId: turn.threadId, botId: turn.botId, input: turn.input },
    { groupTurnPosition: turn.groupTurnPosition, groupState: turn.groupState },
  ));
}

/**
 * [12, 13] A `@slug` handoff from a legacy DM run: the inbound run in the
 * target's thread, then the courier that holds the origin thread (`relaying`,
 * no bot) until the target answers. Inbound first: it points at its courier.
 */
export async function openHandoffTx(
  tx: SQL,
  handoff: {
    organizationId: string;
    originThreadId: string;
    target: { botId: string; threadId: string };
    inboundInput: string;
    courierInput: string;
  },
): Promise<{ inboundId: string; courierId: string }> {
  const courierId = crypto.randomUUID();
  const inboundId = crypto.randomUUID();
  await insertRunTx(tx, queuedRun(
    { id: inboundId, organizationId: handoff.organizationId, threadId: handoff.target.threadId, botId: handoff.target.botId, input: handoff.inboundInput },
    { originRunId: courierId },
  ));
  await insertRunTx(tx, {
    ...queuedRun(
      { id: courierId, organizationId: handoff.organizationId, threadId: handoff.originThreadId, botId: null, input: handoff.courierInput },
      { handoffTargetBotId: handoff.target.botId },
    ),
    status: "relaying",
  });
  return { inboundId, courierId };
}
