import type { AutonomyPolicy } from "@openedbot/roster/domain/autonomous-workflow";
import { ROOM_LIMITS } from "@openedbot/roster/domain/bot-mode";
import { isServiceStepKind, type RunStepKind } from "./run-step";

/**
 * What a creation writes into `runs` and `workflows`. The SQL primitives (`sql/run-writes.ts`) are the
 * only writers; the commands (`application/run-creation.ts`,
 * `application/runner/workflow-steps.ts`) build these rows, one per intention.
 *
 * Every column is spelled out: a creation states each value it writes, the
 * defaults of the table included, so that a reader sees one shape per command.
 */

/** A run is born waiting in the queue, or as a courier holding its thread. */
export type CreatedRunStatus = "queued" | "relaying";

/** The step kinds a workflow step carries. Service kinds never belong to a workflow at creation. */
export const WORKFLOW_STEP_KINDS = ["root", "group", "delegated", "continuation"] as const satisfies readonly RunStepKind[];

export type NewRun = {
  id: string;
  organizationId: string;
  threadId: string;
  botId: string | null;
  input: string;
  status: CreatedRunStatus;
  model: string | null;
  groupTurnPosition: number | null;
  groupState: unknown;
  workflowId: string | null;
  stepIndex: number | null;
  stepKind: RunStepKind | null;
  stackDepth: number;
  callerBotId: string | null;
  callerRunId: string | null;
  resumesRunId: string | null;
  completionKind: string | null;
  executionSessionKey: string | null;
  initiatorUserId: string | null;
  /** Admission ceiling of a run without a workflow: `now() + deadlineSeconds`. */
  deadlineSeconds: number | null;
  origin: string | null;
  planOnly: boolean;
  /** The IANA zone the person's client sent with the message this run answers (0187); `null` otherwise. */
  userTimeZone: string | null;
  sourceMessageId: string | null;
  originRunId: string | null;
  handoffTargetBotId: string | null;
};

/**
 * A workflow opened with its root run, in the same transaction (the deferred
 * `workflows_root_run_fkey` holds it at commit). Thread, organization and root
 * run come from that root run; `used_steps` starts at 1 (the root step).
 */
export type NewWorkflow = {
  id: string;
  rootBotId: string | null;
  initiatorUserId: string | null;
  kind: "dm" | "group" | "routine";
  protocolVersion: number;
  /** Frozen at the opening from a policy the caller read under lock: `enabled` is the autonomy snapshot. */
  budget: AutonomyPolicy;
  usedHandoffs: number;
  recoveryState: Record<string, unknown>;
  planOnly: boolean;
  neverWait: boolean;
};

/** The root kinds a retry replays. A service run (persona draft…) is relaunched from its own screen. */
export type RetryableRootStepKind = "root" | "delegated" | "group";

export function isRetryableRootStepKind(stepKind: string | null): stepKind is RetryableRootStepKind | null {
  return stepKind === null || stepKind === "root" || stepKind === "delegated" || stepKind === "group";
}

/** The root run of a new workflow: its workflow and step index come from the opening. */
export type NewRootRun = Omit<NewRun, "workflowId" | "stepIndex" | "status">;

/** A queued run with the table defaults; each command overrides what it writes. */
export function queuedRun(
  identity: Pick<NewRun, "id" | "organizationId" | "threadId" | "botId" | "input">,
  columns: Partial<Omit<NewRun, "id" | "organizationId" | "threadId" | "botId" | "input" | "status">> = {},
): NewRun {
  return {
    ...identity,
    status: "queued",
    model: null,
    groupTurnPosition: null,
    groupState: null,
    workflowId: null,
    stepIndex: null,
    stepKind: null,
    stackDepth: 0,
    callerBotId: null,
    callerRunId: null,
    resumesRunId: null,
    completionKind: null,
    executionSessionKey: null,
    initiatorUserId: null,
    deadlineSeconds: null,
    origin: null,
    planOnly: false,
    userTimeZone: null,
    sourceMessageId: null,
    originRunId: null,
    handoffTargetBotId: null,
    ...columns,
  };
}

/**
 * The first broken invariant of a new run, or `null`. A violation is a
 * programming error of a command, never an input to report to a client: the
 * primitive refuses to write it.
 */
export function newRunViolation(run: NewRun): string | null {
  if (run.status !== "queued" && run.status !== "relaying") return "RUN_CREATED_STATUS";
  if (!Number.isInteger(run.stackDepth) || run.stackDepth < 0) return "RUN_STACK_DEPTH";
  const courier = run.status === "relaying";
  if (courier !== (run.handoffTargetBotId !== null)) return "RUN_COURIER_TARGET";
  if (courier && (run.botId !== null || run.workflowId !== null || run.stepKind !== null)) return "RUN_COURIER_SHAPE";
  if (run.workflowId !== null) {
    if (run.stepIndex === null || !Number.isInteger(run.stepIndex) || run.stepIndex < 0) return "RUN_STEP_INDEX";
    if (!(WORKFLOW_STEP_KINDS as readonly string[]).includes(run.stepKind ?? "")) return "RUN_WORKFLOW_STEP_KIND";
    // A workflow carries its own deadline: the run's envelope is for runs without one.
    if (run.deadlineSeconds !== null) return "RUN_WORKFLOW_DEADLINE";
  }
  if ((run.stepKind === "delegated" || run.stepKind === "continuation") && run.workflowId === null) {
    return "RUN_STEP_WITHOUT_WORKFLOW";
  }
  if (run.stepKind === "delegated" && run.callerBotId === null) return "RUN_DELEGATED_WITHOUT_CALLER";
  if (isServiceStepKind(run.stepKind) && run.workflowId !== null) return "RUN_SERVICE_IN_WORKFLOW";
  if (run.deadlineSeconds !== null && (!Number.isFinite(run.deadlineSeconds) || run.deadlineSeconds <= 0)) {
    return "RUN_DEADLINE";
  }
  return null;
}

/** The first broken invariant of a workflow opened with `root`, or `null`. */
export function newWorkflowViolation(workflow: NewWorkflow, root: NewRootRun): string | null {
  if (root.stepKind !== "root" && root.stepKind !== "group" && root.stepKind !== "delegated") {
    return "WORKFLOW_ROOT_STEP_KIND";
  }
  if ((workflow.kind === "group") !== (root.stepKind === "group")) return "WORKFLOW_GROUP_ROOT";
  // A room runs up to its member turns, whatever the speaker's autonomy policy.
  if (workflow.kind === "group" && workflow.budget.maxSteps !== ROOM_LIMITS.maxMemberTurns) return "WORKFLOW_GROUP_BUDGET";
  if (!Number.isInteger(workflow.usedHandoffs) || workflow.usedHandoffs < 0) return "WORKFLOW_USED_HANDOFFS";
  // The root step is counted (`used_steps = 1`): a delegated root has used its handoff.
  if ((root.stepKind === "delegated") !== (workflow.usedHandoffs === 1)) return "WORKFLOW_ROOT_HANDOFF";
  return null;
}
