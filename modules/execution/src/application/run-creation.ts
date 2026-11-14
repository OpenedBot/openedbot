import type { SQL } from "bun";
import { workflowSessionKey, type AutonomyPolicy } from "@openedbot/roster/domain/autonomous-workflow";
import { queuedRun, type NewRootRun, type RetryableRootStepKind } from "../domain/run-creation";
import { insertRunTx, openWorkflowTx } from "../sql/run-writes";

/**
 * The commands that admit a new turn from outside the worker: one per intention, each in its caller's
 * transaction, each built on the private primitives of `sql/run-writes.ts`.
 * They lock nothing and read no policy: the caller has taken its locks, in its
 * order, and froze the budget it passes. The worker's own creations (workflow
 * steps, handoff, legacy room chaining) are in `runner/workflow-steps.ts`.
 *
 * Numbers in brackets are the creation sites of the inventory (0002, 3.1).
 */

/** Who answers a new turn: the addressed bot, a room's first speaker, or a bot an `@mention` delegated to. */
export type TurnSpeaker =
  | { kind: "root"; botId: string }
  | { kind: "group"; botId: string; position: number | null; state: unknown }
  | { kind: "delegated"; botId: string; callerBotId: string };

type OpenedWorkflow = { id: string; kind: "dm" | "group"; rootBotId: string | null; budget: AutonomyPolicy };

/** The step columns of a turn's first run, for its speaker. */
function speakerColumns(
  organizationId: string,
  workflowId: string | null,
  speaker: TurnSpeaker,
): Pick<NewRootRun, "stepKind" | "stackDepth" | "callerBotId" | "executionSessionKey" | "groupTurnPosition" | "groupState"> {
  if (speaker.kind === "group") {
    return {
      stepKind: "group", stackDepth: 0, callerBotId: null, executionSessionKey: null,
      groupTurnPosition: speaker.position, groupState: speaker.state,
    };
  }
  if (speaker.kind === "delegated") {
    // The delegated bot answers in the workflow's own session; without a
    // workflow the shape is refused by the primitive.
    return {
      stepKind: "delegated", stackDepth: 1, callerBotId: speaker.callerBotId,
      executionSessionKey: workflowId ? workflowSessionKey(organizationId, workflowId, speaker.botId) : null,
      groupTurnPosition: null, groupState: null,
    };
  }
  return {
    stepKind: "root", stackDepth: 0, callerBotId: null, executionSessionKey: null,
    groupTurnPosition: null, groupState: null,
  };
}

/**
 * [1] An operator message that opens a turn (`POST /threads/:id/messages`,
 * dispositions `new`, `steer` fallback and `supersede`). A room, a mention or
 * an autonomous bot opens a workflow; a plain DM (and a steer fallback) has
 * none and carries its own admission envelope: `deadline_at` from the bot's
 * autonomy timeout. The run always carries its initiator.
 */
export async function admitUserTurnTx(
  tx: SQL,
  turn: {
    organizationId: string;
    threadId: string;
    runId: string;
    initiatorUserId: string;
    input: string;
    planOnly: boolean;
    /** Validated by the caller (`readUserTimeZone`); `null` when the client sent none. */
    userTimeZone?: string | null;
    speaker: TurnSpeaker;
    workflow: OpenedWorkflow | null;
    admissionTimeoutSeconds: number;
  },
): Promise<void> {
  const run = queuedRun(
    { id: turn.runId, organizationId: turn.organizationId, threadId: turn.threadId, botId: turn.speaker.botId, input: turn.input },
    {
      ...speakerColumns(turn.organizationId, turn.workflow?.id ?? null, turn.speaker),
      initiatorUserId: turn.initiatorUserId,
      planOnly: turn.planOnly,
      userTimeZone: turn.userTimeZone ?? null,
    },
  );
  if (!turn.workflow) {
    await insertRunTx(tx, { ...run, stepIndex: 0, deadlineSeconds: turn.admissionTimeoutSeconds });
    return;
  }
  await openWorkflowTx(tx, {
    id: turn.workflow.id,
    rootBotId: turn.workflow.rootBotId,
    initiatorUserId: turn.initiatorUserId,
    kind: turn.workflow.kind,
    protocolVersion: 1,
    budget: turn.workflow.budget,
    usedHandoffs: turn.speaker.kind === "delegated" ? 1 : 0,
    recoveryState: {},
    planOnly: turn.planOnly,
    neverWait: false,
  }, run);
}

/**
 * [2] A variant or a regeneration of a message, in its new branch thread:
 * always a DM workflow, with the restrictions of the source turn.
 */
export async function branchTurnTx(
  tx: SQL,
  turn: {
    organizationId: string;
    threadId: string;
    runId: string;
    workflowId: string;
    initiatorUserId: string;
    rootBotId: string;
    input: string;
    speaker: Extract<TurnSpeaker, { kind: "root" | "delegated" }>;
    budget: AutonomyPolicy;
    planOnly: boolean;
    neverWait: boolean;
  },
): Promise<void> {
  await openWorkflowTx(tx, {
    id: turn.workflowId,
    rootBotId: turn.rootBotId,
    initiatorUserId: turn.initiatorUserId,
    kind: "dm",
    protocolVersion: 1,
    budget: turn.budget,
    usedHandoffs: turn.speaker.kind === "delegated" ? 1 : 0,
    recoveryState: {},
    planOnly: turn.planOnly,
    neverWait: turn.neverWait,
  }, queuedRun(
    { id: turn.runId, organizationId: turn.organizationId, threadId: turn.threadId, botId: turn.speaker.botId, input: turn.input },
    { ...speakerColumns(turn.organizationId, turn.workflowId, turn.speaker), planOnly: turn.planOnly },
  ));
}

/**
 * [3] A webhook delivery accepted for its endpoint's thread: always a
 * workflow, whose initiator is the endpoint's author.
 */
export async function admitWebhookDeliveryTx(
  tx: SQL,
  delivery: {
    organizationId: string;
    threadId: string;
    runId: string;
    workflowId: string;
    initiatorUserId: string | null;
    input: string;
    speaker: Extract<TurnSpeaker, { kind: "root" | "group" }>;
    budget: AutonomyPolicy;
  },
): Promise<void> {
  await openWorkflowTx(tx, {
    id: delivery.workflowId,
    rootBotId: delivery.speaker.botId,
    initiatorUserId: delivery.initiatorUserId,
    kind: delivery.speaker.kind === "group" ? "group" : "dm",
    protocolVersion: 1,
    budget: delivery.budget,
    usedHandoffs: 0,
    recoveryState: {},
    planOnly: false,
    neverWait: false,
  }, queuedRun(
    { id: delivery.runId, organizationId: delivery.organizationId, threadId: delivery.threadId, botId: delivery.speaker.botId, input: delivery.input },
    speakerColumns(delivery.organizationId, delivery.workflowId, delivery.speaker),
  ));
}

/** The root run a retry replays, read under lock by the caller. */
export type RetriedRoot = {
  botId: string;
  input: string;
  model: string | null;
  stepKind: RetryableRootStepKind | null;
  stackDepth: number;
  callerBotId: string | null;
  groupTurnPosition: number | null;
  groupState: unknown;
  planOnly: boolean;
  neverWait: boolean;
  sourceMessageId: string | null;
};

/**
 * [4] The creation half of an explicit retry with duplicate risk: a new
 * workflow that copies the budget of the one it replaces, and its root run,
 * a copy of the replaced root (same restrictions, same source message). The
 * caller settles the replaced workflow and its `unknown` runs (S2d).
 */
export async function openWorkflowRetryTx(
  tx: SQL,
  retry: {
    organizationId: string;
    threadId: string;
    workflowId: string;
    runId: string;
    initiatorUserId: string;
    replaced: { id: string; kind: "dm" | "routine"; rootBotId: string | null; protocolVersion: number; budget: AutonomyPolicy };
    root: RetriedRoot;
  },
): Promise<void> {
  const root = retry.root;
  const stepKind = root.stepKind ?? "root";
  await openWorkflowTx(tx, {
    id: retry.workflowId,
    rootBotId: retry.replaced.rootBotId,
    initiatorUserId: retry.initiatorUserId,
    kind: retry.replaced.kind,
    protocolVersion: retry.replaced.protocolVersion,
    budget: retry.replaced.budget,
    usedHandoffs: stepKind === "delegated" ? 1 : 0,
    recoveryState: { retryOf: retry.replaced.id, duplicateRisk: true },
    planOnly: root.planOnly,
    neverWait: root.neverWait,
  }, queuedRun(
    { id: retry.runId, organizationId: retry.organizationId, threadId: retry.threadId, botId: root.botId, input: root.input },
    {
      model: root.model,
      groupTurnPosition: root.groupTurnPosition,
      groupState: root.groupState,
      stepKind,
      stackDepth: root.stackDepth,
      callerBotId: root.callerBotId,
      executionSessionKey: stepKind === "root" ? null : workflowSessionKey(retry.organizationId, retry.workflowId, root.botId),
      planOnly: root.planOnly,
      sourceMessageId: root.sourceMessageId,
    },
  ));
}

/**
 * [5, 8, 9] A routine occurrence, launched by hand or by the schedule: a
 * `routine` workflow for a bot, a `group` workflow for a room, that never
 * waits for a person when the routine says so.
 */
export async function fireRoutineTx(
  tx: SQL,
  occurrence: {
    trigger: "manual" | "scheduled";
    routineId: string;
    organizationId: string;
    threadId: string;
    runId: string;
    workflowId: string;
    initiatorUserId: string | null;
    input: string;
    speaker: Extract<TurnSpeaker, { kind: "root" | "group" }>;
    budget: AutonomyPolicy;
    neverWait: boolean;
  },
): Promise<void> {
  await openWorkflowTx(tx, {
    id: occurrence.workflowId,
    rootBotId: occurrence.speaker.botId,
    initiatorUserId: occurrence.initiatorUserId,
    kind: occurrence.speaker.kind === "group" ? "group" : "routine",
    protocolVersion: 1,
    budget: occurrence.budget,
    usedHandoffs: 0,
    recoveryState: { routineId: occurrence.routineId, trigger: occurrence.trigger },
    planOnly: false,
    neverWait: occurrence.neverWait,
  }, queuedRun(
    { id: occurrence.runId, organizationId: occurrence.organizationId, threadId: occurrence.threadId, botId: occurrence.speaker.botId, input: occurrence.input },
    speakerColumns(occurrence.organizationId, occurrence.workflowId, occurrence.speaker),
  ));
}

/**
 * [6] A persona draft of a bot, in its draft thread: a service run, without
 * workflow, initiator or admission envelope (inventory D8). If it becomes
 * `unknown`, the review trigger gives it a workflow (0175).
 */
export async function queuePersonaDraftRunTx(
  tx: SQL,
  draft: { organizationId: string; threadId: string; botId: string; prompt: string; sessionKey: string },
): Promise<string> {
  const runId = crypto.randomUUID();
  await insertRunTx(tx, queuedRun(
    { id: runId, organizationId: draft.organizationId, threadId: draft.threadId, botId: draft.botId, input: draft.prompt },
    { stepKind: "persona_draft", stackDepth: 0, executionSessionKey: draft.sessionKey },
  ));
  return runId;
}

/**
 * [7] The hidden first message of a new bot, without an operator message: a
 * plain DM turn of its creator, whose envelope is the bot's autonomy timeout.
 */
export async function greetNewBotTx(
  tx: SQL,
  greeting: { organizationId: string; threadId: string; botId: string; initiatorUserId: string; input: string },
): Promise<string> {
  const bots = await tx<Array<{ timeoutSeconds: number | null }>>`
    select autonomy_timeout_seconds as "timeoutSeconds" from bots
     where organization_id = ${greeting.organizationId} and id = ${greeting.botId}
  `;
  const runId = crypto.randomUUID();
  await insertRunTx(tx, queuedRun(
    { id: runId, organizationId: greeting.organizationId, threadId: greeting.threadId, botId: greeting.botId, input: greeting.input },
    {
      stepIndex: 0,
      stepKind: "root",
      initiatorUserId: greeting.initiatorUserId,
      deadlineSeconds: bots[0]?.timeoutSeconds ?? null,
      origin: "bot_greeting",
    },
  ));
  return runId;
}
