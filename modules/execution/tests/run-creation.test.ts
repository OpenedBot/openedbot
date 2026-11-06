import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { workflowSessionKey } from "@openedbot/roster/domain/autonomous-workflow";
import { ROOM_LIMITS } from "@openedbot/roster/domain/bot-mode";
import {
  isRetryableRootStepKind,
  newRunViolation,
  newWorkflowViolation,
  queuedRun,
  type NewWorkflow,
} from "../src/domain/run-creation";
import {
  admitUserTurnTx,
  admitWebhookDeliveryTx,
  branchTurnTx,
  fireRoutineTx,
  greetNewBotTx,
  openWorkflowRetryTx,
  queuePersonaDraftRunTx,
} from "../src/application/run-creation";
import { chainLegacyRoomTurnTx, openHandoffTx, startWorkflowStepTx } from "../src/application/runner/workflow-steps";
import { insertRunTx, openWorkflowTx } from "../src/sql/run-writes";
import { insertedRow } from "../../../tests/sql-insert-columns";

type Call = { sql: string; values: unknown[] };

function fakeTx(answer: (sql: string) => unknown[] = () => []): { tx: SQL; calls: Call[] } {
  const calls: Call[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    calls.push({ sql, values });
    return Promise.resolve(answer(sql));
  }) as unknown as SQL;
  return { tx, calls };
}

const inserts = (calls: Call[], table: "runs" | "workflows") => calls
  .filter(({ sql }) => sql.includes(`insert into ${table}`))
  .map(({ sql, values }) => insertedRow(sql, values));

const ORG = "org-1";
const POLICY = { enabled: false, maxDepth: 3, maxSteps: 8, maxHandoffs: 4, timeoutSeconds: 900, tokenBudget: 50_000 };

describe("newRunViolation", () => {
  const base = queuedRun({ id: "run", organizationId: ORG, threadId: "thread", botId: "bot", input: "hi" });

  test("the table defaults make a valid plain run", () => {
    expect(newRunViolation(base)).toBeNull();
    expect(base).toMatchObject({ status: "queued", stackDepth: 0, planOnly: false, workflowId: null, deadlineSeconds: null });
  });

  test("refuses the shapes no creation writes", () => {
    const cases: Array<[Partial<typeof base>, string]> = [
      [{ status: "unknown" as never }, "RUN_CREATED_STATUS"],
      [{ stackDepth: -1 }, "RUN_STACK_DEPTH"],
      [{ status: "relaying" }, "RUN_COURIER_TARGET"],
      [{ handoffTargetBotId: "bot-2" }, "RUN_COURIER_TARGET"],
      [{ status: "relaying", handoffTargetBotId: "bot-2" }, "RUN_COURIER_SHAPE"],
      [{ workflowId: "wf", stepKind: "root" }, "RUN_STEP_INDEX"],
      [{ workflowId: "wf", stepIndex: 0, stepKind: "persona_draft" }, "RUN_WORKFLOW_STEP_KIND"],
      [{ workflowId: "wf", stepIndex: 0, stepKind: "root", deadlineSeconds: 60 }, "RUN_WORKFLOW_DEADLINE"],
      [{ stepKind: "continuation" }, "RUN_STEP_WITHOUT_WORKFLOW"],
      [{ workflowId: "wf", stepIndex: 1, stepKind: "delegated" }, "RUN_DELEGATED_WITHOUT_CALLER"],
      [{ deadlineSeconds: 0 }, "RUN_DEADLINE"],
    ];
    for (const [columns, violation] of cases) {
      expect(newRunViolation({ ...base, ...columns })).toBe(violation);
    }
  });

  test("a courier holds its thread without a bot, a workflow or a step", () => {
    expect(newRunViolation({ ...base, botId: null, status: "relaying", handoffTargetBotId: "bot-2" })).toBeNull();
  });
});

describe("newWorkflowViolation", () => {
  const workflow: NewWorkflow = {
    id: "wf", rootBotId: "bot", initiatorUserId: "user", kind: "dm", protocolVersion: 1, budget: POLICY,
    usedHandoffs: 0, recoveryState: {}, planOnly: false, neverWait: false,
  };
  const root = { ...queuedRun({ id: "run", organizationId: ORG, threadId: "thread", botId: "bot", input: "hi" }), stepKind: "root" as const };

  test("a room opens with its member turns and a group root; a delegated root has used its handoff", () => {
    expect(newWorkflowViolation(workflow, root)).toBeNull();
    expect(newWorkflowViolation({ ...workflow, kind: "group" }, { ...root, stepKind: "group" })).toBe("WORKFLOW_GROUP_BUDGET");
    expect(newWorkflowViolation(
      { ...workflow, kind: "group", budget: { ...POLICY, maxSteps: ROOM_LIMITS.maxMemberTurns } },
      { ...root, stepKind: "group" },
    )).toBeNull();
    expect(newWorkflowViolation({ ...workflow, kind: "group" }, root)).toBe("WORKFLOW_GROUP_ROOT");
    expect(newWorkflowViolation(workflow, { ...root, stepKind: "delegated", callerBotId: "bot-0" })).toBe("WORKFLOW_ROOT_HANDOFF");
    expect(newWorkflowViolation(workflow, { ...root, stepKind: "continuation" })).toBe("WORKFLOW_ROOT_STEP_KIND");
  });

  test("a refused shape writes nothing", async () => {
    const { tx, calls } = fakeTx();
    await expect(openWorkflowTx(tx, { ...workflow, usedHandoffs: 1 }, root)).rejects.toThrow("WORKFLOW_ROOT_HANDOFF");
    await expect(insertRunTx(tx, { ...root, status: "relaying" })).rejects.toThrow("RUN_COURIER_TARGET");
    expect(calls).toHaveLength(0);
  });

  test("only a turn kind is replayed by a retry", () => {
    expect(["root", "delegated", "group", null].every(isRetryableRootStepKind)).toBe(true);
    expect(isRetryableRootStepKind("persona_draft")).toBe(false);
    expect(isRetryableRootStepKind("continuation")).toBe(false);
  });
});

describe("admission commands", () => {
  test("[1] a plain DM has no workflow and carries its initiator and admission ceiling", async () => {
    const { tx, calls } = fakeTx();
    await admitUserTurnTx(tx, {
      organizationId: ORG, threadId: "thread", runId: "run", initiatorUserId: "user", input: "hello",
      planOnly: true, speaker: { kind: "root", botId: "bot" }, workflow: null, admissionTimeoutSeconds: 900,
    });
    expect(inserts(calls, "workflows")).toHaveLength(0);
    expect(inserts(calls, "runs")).toEqual([expect.objectContaining({
      id: "run", bot_id: "bot", status: "queued", workflow_id: null, step_index: 0, step_kind: "root",
      initiator_user_id: "user", deadline_at: 900, plan_only: true, external_state: "not_started", events_complete: true,
    })]);
  });

  test("[1] a mention opens the workflow first, then the delegated root in its session", async () => {
    const { tx, calls } = fakeTx();
    await admitUserTurnTx(tx, {
      organizationId: ORG, threadId: "thread", runId: "run", initiatorUserId: "user", input: "check",
      planOnly: false, speaker: { kind: "delegated", botId: "target", callerBotId: "bot" },
      workflow: { id: "wf", kind: "dm", rootBotId: "bot", budget: { ...POLICY, maxSteps: 8, maxHandoffs: 1 } },
      admissionTimeoutSeconds: 900,
    });
    expect(calls.map(({ sql }) => sql.includes("insert into workflows") ? "workflow" : "run")).toEqual(["workflow", "run"]);
    expect(inserts(calls, "workflows")[0]).toMatchObject({
      id: "wf", root_run_id: "run", root_bot_id: "bot", initiator_user_id: "user", kind: "dm", status: "queued",
      used_steps: 1, used_handoffs: 1, used_tokens: 0, max_handoffs: 1, deadline_at: 900, recovery_state: {},
    });
    expect(inserts(calls, "runs")[0]).toMatchObject({
      workflow_id: "wf", step_index: 0, step_kind: "delegated", stack_depth: 1, caller_bot_id: "bot",
      execution_session_key: workflowSessionKey(ORG, "wf", "target"), initiator_user_id: "user", deadline_at: null,
    });
  });

  test("[2] a branch keeps the source restrictions and puts no initiator on the run", async () => {
    const { tx, calls } = fakeTx();
    await branchTurnTx(tx, {
      organizationId: ORG, threadId: "branch", runId: "run", workflowId: "wf", initiatorUserId: "user",
      rootBotId: "bot", input: "again", speaker: { kind: "root", botId: "bot" }, budget: POLICY,
      planOnly: true, neverWait: true,
    });
    expect(inserts(calls, "workflows")[0]).toMatchObject({ thread_id: "branch", kind: "dm", plan_only: true, never_wait: true });
    expect(inserts(calls, "runs")[0]).toMatchObject({ thread_id: "branch", initiator_user_id: null, plan_only: true });
  });

  test("[3] a webhook room delivery opens a group workflow for its first speaker", async () => {
    const { tx, calls } = fakeTx();
    await admitWebhookDeliveryTx(tx, {
      organizationId: ORG, threadId: "room", runId: "run", workflowId: "wf", initiatorUserId: "author",
      input: "build failed", speaker: { kind: "group", botId: "bot", position: 1, state: { phase: "open" } },
      budget: { ...POLICY, maxSteps: ROOM_LIMITS.maxMemberTurns },
    });
    expect(inserts(calls, "workflows")[0]).toMatchObject({ kind: "group", initiator_user_id: "author", plan_only: false });
    expect(inserts(calls, "runs")[0]).toMatchObject({
      step_kind: "group", group_turn_position: 1, group_state: { phase: "open" }, initiator_user_id: null,
    });
  });

  test("[4] a retry copies the replaced budget and the root's restrictions", async () => {
    const { tx, calls } = fakeTx();
    await openWorkflowRetryTx(tx, {
      organizationId: ORG, threadId: "thread", workflowId: "wf-2", runId: "run-2", initiatorUserId: "operator",
      replaced: { id: "wf-1", kind: "routine", rootBotId: "bot", protocolVersion: 1, budget: POLICY },
      root: {
        botId: "bot", input: "redo", model: "m", stepKind: null, stackDepth: 0, callerBotId: null,
        groupTurnPosition: null, groupState: null, planOnly: true, neverWait: true, sourceMessageId: "message-1",
      },
    });
    expect(inserts(calls, "workflows")[0]).toMatchObject({
      kind: "routine", initiator_user_id: "operator", recovery_state: { retryOf: "wf-1", duplicateRisk: true },
      plan_only: true, never_wait: true, used_handoffs: 0,
    });
    expect(inserts(calls, "runs")[0]).toMatchObject({
      step_kind: "root", model: "m", execution_session_key: null, plan_only: true, source_message_id: "message-1",
    });
  });

  test("[5, 8, 9] a routine opens a routine workflow for a bot, a group workflow for a room", async () => {
    const bot = fakeTx();
    await fireRoutineTx(bot.tx, {
      trigger: "manual", routineId: "routine", organizationId: ORG, threadId: "thread", runId: "run",
      workflowId: "wf", initiatorUserId: "user", input: "[Routine]", speaker: { kind: "root", botId: "bot" },
      budget: POLICY, neverWait: true,
    });
    expect(inserts(bot.calls, "workflows")[0]).toMatchObject({
      kind: "routine", recovery_state: { routineId: "routine", trigger: "manual" }, never_wait: true,
    });
    const room = fakeTx();
    await fireRoutineTx(room.tx, {
      trigger: "scheduled", routineId: "routine", organizationId: ORG, threadId: "room", runId: "run",
      workflowId: "wf", initiatorUserId: null, input: "[Routine]",
      speaker: { kind: "group", botId: "bot", position: 0, state: { phase: "open" } },
      budget: { ...POLICY, maxSteps: ROOM_LIMITS.maxMemberTurns }, neverWait: false,
    });
    expect(inserts(room.calls, "workflows")[0]).toMatchObject({ kind: "group", max_steps: ROOM_LIMITS.maxMemberTurns });
    expect(inserts(room.calls, "runs")[0]).toMatchObject({ step_kind: "group", group_turn_position: 0 });
  });

  test("[6] a persona draft is a service run without workflow, initiator or envelope", async () => {
    const { tx, calls } = fakeTx();
    const runId = await queuePersonaDraftRunTx(tx, {
      organizationId: ORG, threadId: "draft-thread", botId: "bot", prompt: "transcript", sessionKey: "draft-session",
    });
    expect(inserts(calls, "runs")).toEqual([expect.objectContaining({
      id: runId, step_kind: "persona_draft", step_index: null, workflow_id: null, initiator_user_id: null,
      deadline_at: null, execution_session_key: "draft-session",
    })]);
  });

  test("[7] a greeting is a plain DM whose envelope is the bot's autonomy timeout", async () => {
    const { tx, calls } = fakeTx((sql) => sql.includes("autonomy_timeout_seconds") ? [{ timeoutSeconds: 600 }] : []);
    await greetNewBotTx(tx, { organizationId: ORG, threadId: "thread", botId: "bot", initiatorUserId: "user", input: "hi" });
    expect(inserts(calls, "runs")[0]).toMatchObject({
      step_index: 0, step_kind: "root", initiator_user_id: "user", deadline_at: 600, origin: "bot_greeting",
    });
  });
});

describe("worker step commands", () => {
  test("[10] a room's next speaker counts one step, without handoff", async () => {
    const { tx, calls } = fakeTx();
    await startWorkflowStepTx(tx, {
      kind: "group", organizationId: ORG, threadId: "room", workflowId: "wf", stepIndex: 2,
      botId: "bot", groupTurnPosition: 1, groupState: { phase: "open" },
    });
    expect(inserts(calls, "runs")[0]).toMatchObject({
      input: "", workflow_id: "wf", step_index: 2, step_kind: "group", stack_depth: 0, execution_session_key: null,
    });
    expect(calls[1]?.sql).toContain("used_steps = used_steps + 1");
    expect(calls[1]?.sql).not.toContain("used_handoffs");
  });

  test("[14] a delegation counts one step and one handoff, in the target's workflow session", async () => {
    const { tx, calls } = fakeTx();
    const id = await startWorkflowStepTx(tx, {
      kind: "delegated", organizationId: ORG, threadId: "thread", workflowId: "wf", stepIndex: 1,
      botId: "target", input: "do it", stackDepth: 1, callerBotId: "bot", callerRunId: "run-1",
    });
    expect(inserts(calls, "runs")[0]).toMatchObject({
      id, step_kind: "delegated", caller_bot_id: "bot", caller_run_id: "run-1",
      execution_session_key: workflowSessionKey(ORG, "wf", "target"),
    });
    expect(calls[1]?.sql).toContain("used_handoffs = used_handoffs + 1");
  });

  test("[15] a continuation resumes the caller with the completion it carries", async () => {
    const { tx, calls } = fakeTx();
    await startWorkflowStepTx(tx, {
      kind: "continuation", organizationId: ORG, threadId: "thread", workflowId: "wf", stepIndex: 2,
      botId: "bot", input: "result", stackDepth: 0, callerBotId: null, callerRunId: null,
      resumesRunId: "run-1", completionKind: "child_result",
    });
    expect(inserts(calls, "runs")[0]).toMatchObject({
      step_kind: "continuation", resumes_run_id: "run-1", completion_kind: "child_result",
      execution_session_key: workflowSessionKey(ORG, "wf", "bot"),
    });
    expect(calls[1]?.sql).not.toContain("used_handoffs");
  });

  test("[11, 16] a legacy room turn has no workflow, step or envelope", async () => {
    const { tx, calls } = fakeTx();
    await chainLegacyRoomTurnTx(tx, {
      organizationId: ORG, threadId: "room", botId: "bot", groupTurnPosition: 2, input: "same input", groupState: null,
    });
    expect(inserts(calls, "runs")[0]).toMatchObject({
      input: "same input", group_turn_position: 2, workflow_id: null, step_index: null, step_kind: null, deadline_at: null,
    });
    expect(calls).toHaveLength(1);
  });

  test("[12, 13] a handoff inserts the inbound run, then its courier holding the origin thread", async () => {
    const { tx, calls } = fakeTx();
    const { inboundId, courierId } = await openHandoffTx(tx, {
      organizationId: ORG, originThreadId: "origin", target: { botId: "target", threadId: "target-thread" },
      inboundInput: "from neo: check", courierInput: "check",
    });
    expect(inserts(calls, "runs")).toEqual([
      expect.objectContaining({ id: inboundId, thread_id: "target-thread", bot_id: "target", status: "queued", origin_run_id: courierId }),
      expect.objectContaining({ id: courierId, thread_id: "origin", bot_id: null, status: "relaying", handoff_target_bot_id: "target" }),
    ]);
  });
});
