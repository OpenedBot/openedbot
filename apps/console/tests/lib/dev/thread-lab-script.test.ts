import { describe, expect, test } from "bun:test";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import {
  deriveLabTurns,
  LAB_SCENARIOS,
  labFragments,
  labScenario,
  planLabReply,
  type LabRun,
  type LabUserInput,
} from "../../../src/lib/dev/thread-lab-script";

const at = new Date("2026-10-24T10:00:00.000Z");

function stored(runId: string, plan: ReturnType<typeof planLabReply>, upTo = plan.length): StoredProductEvent[] {
  return plan.slice(0, upTo).map((step, index) => ({
    cursor: index + 1,
    sequence: index + 1,
    runId,
    type: step.type,
    payload: step.payload,
    occurredAt: at,
  }));
}

function turnFor(scenarioId: string, status: LabRun["status"], upTo?: number) {
  const plan = planLabReply(labScenario(scenarioId));
  const user: LabUserInput = { id: "u1", text: "?", runId: "r1", createdAt: at.toISOString() };
  const run: LabRun = { id: "r1", status, model: "m", createdAt: at.toISOString(), endedAt: null };
  const [turn] = deriveLabTurns([user], stored("r1", plan, upTo), [run]);
  return { plan, assistant: turn!.assistant! };
}

describe("labFragments", () => {
  test("recomposes the original text byte for byte", () => {
    for (const scenario of LAB_SCENARIOS) {
      for (const step of scenario.steps) {
        if (step.kind === "say") expect(labFragments(step.text).join("")).toBe(step.text);
      }
    }
  });
});

describe("planLabReply", () => {
  test("a tool result follows its call, transcripts land after the tools, run.completed is last", () => {
    const plan = planLabReply(labScenario("tools"));
    const types = plan.map((step) => step.type);
    expect(types[types.length - 1]).toBe("run.completed");
    const lastResult = types.lastIndexOf("tool.result");
    const firstAttached = types.indexOf("tool.result.attached");
    expect(firstAttached).toBeGreaterThan(lastResult);
    for (const [index, step] of plan.entries()) {
      if (step.type !== "tool.result") continue;
      const call = plan.findIndex((other) => other.type === "tool.call" && other.payload.toolCallId === step.payload.toolCallId);
      expect(call).toBeGreaterThanOrEqual(0);
      expect(call).toBeLessThan(index);
    }
  });

  test("a failing scenario ends on run.error and never completes", () => {
    const types = planLabReply(labScenario("run-failed")).map((step) => step.type);
    expect(types[types.length - 1]).toBe("run.error");
    expect(types).not.toContain("run.completed");
  });

  test("an unknown scenario id falls back to the first one", () => {
    expect(labScenario("nope").id).toBe(LAB_SCENARIOS[0]!.id);
  });
});

describe("deriveLabTurns", () => {
  test("a settled run splits narration and tools from the answer", () => {
    const { assistant } = turnFor("tools", "completed");
    expect(assistant.activity.map((part) => part.kind)).toEqual(["narration", "tool", "tool", "narration", "tool"]);
    expect(assistant.activity.every((part) => part.kind !== "tool" || part.status === "done")).toBe(true);
    expect(assistant.answer.startsWith("Le test clique")).toBe(true);
    const terminal = assistant.activity[4];
    expect(terminal?.kind === "tool" ? terminal.result : null).toContain("8 pass");
  });

  test("while live, a short text after a tool stays narration", () => {
    const plan = planLabReply(labScenario("tools"));
    const firstTextAfterTool = plan.findIndex((step, index) =>
      step.type === "agent.message" && plan.slice(0, index).some((previous) => previous.type === "tool.result"));
    const { assistant } = turnFor("tools", "running", firstTextAfterTool + 1);
    expect(assistant.answer).toBe("");
    expect(assistant.liveNote.length).toBeGreaterThan(0);
    expect(assistant.activity[assistant.activity.length - 1]?.kind).toBe("tool");
  });

  test("the first live sentence never takes the answer slot before a tool call can follow it", () => {
    const plan = planLabReply(labScenario("tools"));
    const beforeFirstTool = plan.findIndex((step) => step.type === "tool.call");
    const early = turnFor("tools", "running", beforeFirstTool).assistant;
    expect(early.answer).toBe("");
    expect(early.liveNote).toBe("Je cherche d'abord le test et ses dépendances.");
    const afterCall = turnFor("tools", "running", beforeFirstTool + 1).assistant;
    expect(afterCall.liveNote).toBe("");
    expect(afterCall.activity[0]).toMatchObject({ kind: "narration", text: "Je cherche d'abord le test et ses dépendances." });
  });

  test("a live answer is confirmed by its shape or its length, and every answer at the end", () => {
    const plan = planLabReply(labScenario("answer"));
    const firstFragment = turnFor("answer", "running", 1).assistant;
    expect(firstFragment.answer).toBe("");
    expect(firstFragment.liveNote.length).toBeGreaterThan(0);
    const secondParagraph = plan.findIndex((_, index) =>
      plan.slice(0, index + 1).map((step) => String(step.payload.text ?? "")).join("").includes("\n\n"));
    expect(turnFor("answer", "running", secondParagraph + 1).assistant.answer.length).toBeGreaterThan(0);
    expect(turnFor("tool-error", "completed").assistant.answer.startsWith("Le contexte")).toBe(true);
  });

  test("a running tool reads as running, a failed one as error", () => {
    const plan = planLabReply(labScenario("tool-error"));
    const callIndex = plan.findIndex((step) => step.type === "tool.call");
    const live = turnFor("tool-error", "running", callIndex + 1).assistant;
    expect(live.activity.find((part) => part.kind === "tool")).toMatchObject({ status: "running" });
    const done = turnFor("tool-error", "completed").assistant;
    expect(done.activity.find((part) => part.kind === "tool")).toMatchObject({ status: "error", errorMessage: "command failed: exit status 1" });
  });

  test("run.error and the cancel notice surface on the turn", () => {
    expect(turnFor("run-failed", "failed").assistant.errorMessage).toBe("Le fournisseur a refusé la requête (quota dépassé).");
    const user: LabUserInput = { id: "u1", text: "?", runId: "r1", createdAt: at.toISOString() };
    const run: LabRun = { id: "r1", status: "cancelled", model: null, createdAt: at.toISOString(), endedAt: at.toISOString() };
    const notice: StoredProductEvent = { cursor: 1, sequence: 1, runId: "r1", type: "system.notice", payload: { kind: "cancelled", message: "x" }, occurredAt: at };
    expect(deriveLabTurns([user], [notice], [run])[0]?.assistant?.cancelled).toBe(true);
  });

  test("a message without a run has no assistant turn", () => {
    const user: LabUserInput = { id: "u1", text: "?", runId: null, createdAt: at.toISOString() };
    expect(deriveLabTurns([user], [], [])).toEqual([{ user, assistant: null }]);
  });
});
