import { describe, expect, test } from "bun:test";
import {
  AUTONOMY_CEILINGS, AUTONOMY_DEFAULTS, canDelegate, minimumStepsToDelegate,
  normalizeAutonomyPolicy, type WorkflowBudget,
} from "../src/domain/autonomous-workflow";
import { parseMentions } from "../src/domain/bot-mode";

const now = new Date("2026-10-04T00:00:00Z");
const budget: WorkflowBudget = {
  ...AUTONOMY_DEFAULTS, usedSteps: 1, usedHandoffs: 0, usedTokens: 0,
  deadlineAt: new Date(now.getTime() + 60_000),
};
const request = {
  policyEnabled: true, selfBotId: "a", targetBotId: "b", targetActive: true,
  activeCallStackBotIds: ["a"], stackDepth: 0, budget, now,
};

describe("named coordination budgets", () => {
  test("a child reserves its own step and every owed continuation", () => {
    expect(minimumStepsToDelegate(0)).toBe(2);
    expect(minimumStepsToDelegate(2)).toBe(4);
    expect(canDelegate({ ...request, stackDepth: 2, budget: { ...budget, usedSteps: 4 } }))
      .toEqual({ accepted: true, reservedSteps: 4 });
    expect(canDelegate({ ...request, stackDepth: 2, budget: { ...budget, usedSteps: 5 } }))
      .toEqual({ accepted: false, reason: "STEP_LIMIT" });
  });
  test.each([
    ["AUTONOMY_DISABLED", { policyEnabled: false }],
    ["TARGET_SELF", { targetBotId: "a" }],
    ["TARGET_INACTIVE", { targetActive: false }],
    ["CALL_CYCLE", { activeCallStackBotIds: ["a", "b"] }],
    ["DEPTH_LIMIT", { stackDepth: 3 }],
    ["STEP_LIMIT", { budget: { ...budget, usedSteps: 7 } }],
    ["HANDOFF_LIMIT", { budget: { ...budget, usedHandoffs: 4 } }],
    ["TOKEN_BUDGET_EXHAUSTED", { budget: { ...budget, usedTokens: 120_000 } }],
    ["WORKFLOW_DEADLINE_EXCEEDED", { budget: { ...budget, deadlineAt: now } }],
  ] as const)("refuses %s before dispatch", (reason, overrides) => {
    expect(canDelegate({ ...request, ...overrides })).toEqual({ accepted: false, reason });
  });
  test("client values never widen the hard ceiling; hidden controls use defaults", () => {
    const excessive = normalizeAutonomyPolicy({ enabled: true, ...Object.fromEntries(
      Object.keys(AUTONOMY_CEILINGS).map((key) => [key, 9_999_999]),
    ) });
    expect(excessive).toEqual({ enabled: true, ...AUTONOMY_CEILINGS });
    expect(normalizeAutonomyPolicy({ enabled: true, timeoutSeconds: 600 }))
      .toEqual({ ...AUTONOMY_DEFAULTS, enabled: true, timeoutSeconds: 600 });
  });
  test("self directives can be recognized for refusal without enabling legacy self handoffs", () => {
    const a = { id: "a", name: "Alpha", slug: "alpha", description: null, threadId: "thread-a" };
    expect(parseMentions("@alpha task", [a], { selfBotId: "a", mode: "bot" })).toBeNull();
    expect(parseMentions("@alpha task", [a], { selfBotId: "a", mode: "bot", includeSelf: true })?.botId).toBe("a");
  });
});
