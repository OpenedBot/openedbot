import { describe, expect, test } from "bun:test";
import { readRunCards, type StoredProductEvent } from "@openedbot/contracts-events";
import {
  deriveLabTurns,
  LAB_SCENARIOS,
  labFragments,
  labScenario,
  planLabReply,
  type LabRun,
  type LabUserInput,
} from "../../../src/lib/dev/thread-lab-script";
import { THINKING_AGENTS_MAX } from "../../../src/lib/thread/run-thinking-model";

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

  test("backflow: a text shaped like an answer streams fully before a tool call follows it", () => {
    const plan = planLabReply(labScenario("backflow"));
    const firstCall = plan.findIndex((step) => step.type === "tool.call");
    const before = plan.slice(0, firstCall).map((step) => String(step.payload.text ?? "")).join("");
    // Two paragraphs: it reads as the answer until the tool call follows it.
    expect(before).toMatch(/\n\s*\n/);
    const { assistant } = turnFor("backflow", "completed");
    expect(assistant.activity.map((part) => part.kind)).toEqual(["narration", "tool", "narration", "tool"]);
    expect(assistant.answer.startsWith("**1 342 requêtes lentes**")).toBe(true);
  });

  test("delegation: more delegations than header slots, each call spaced from the previous one", () => {
    const plan = planLabReply(labScenario("delegation"));
    const delegations = plan.filter((step) => step.type === "tool.call" && step.payload.tool === "delegate_task");
    // The lead plus its delegates overflow the header: « +N » shows.
    expect(delegations.length + 1).toBeGreaterThan(THINKING_AGENTS_MAX);
    expect(new Set(delegations.map((step) => step.payload.preview)).size).toBe(delegations.length);
    for (const step of delegations) expect(step.delayMs).toBeGreaterThan(0);
    expect(plan[0]).toMatchObject({ type: "agent.message" });
  });

  test("an unknown scenario id falls back to the first one", () => {
    expect(labScenario("nope").id).toBe(LAB_SCENARIOS[0]!.id);
  });

  test("weather: narration, a weather_forecast call whose result carries a valid card, then the answer", () => {
    const plan = planLabReply(labScenario("weather"));
    const call = plan.find((step) => step.type === "tool.call")!;
    expect(call.payload).toMatchObject({ tool: "weather_forecast", preview: "Rennes" });
    const result = plan.find((step) => step.type === "tool.result")!;
    const cards = readRunCards(result.payload.cards);
    expect(cards).toHaveLength(1);
    const { weather } = cards[0]!;
    expect(weather).toMatchObject({ locationLabel: "Rennes", timeZone: "Europe/Paris" });
    expect(weather.days).toHaveLength(7);
    expect(weather.hours).toHaveLength(48);
    expect(weather.days.every((day) => day.sunriseMs !== undefined && day.sunsetMs !== undefined)).toBe(true);
    expect(weather.hours.map((hour) => hour.conditionCode)).toEqual(expect.arrayContaining(["Drizzle", "Rain"]));
    // The answer follows the tool.
    const types = plan.map((step) => step.type);
    expect(types.lastIndexOf("agent.message")).toBeGreaterThan(types.indexOf("tool.result"));
  });

  test("the weather card is stamped when the reply is planned, so its « now » is fresh", () => {
    const before = Date.now();
    const result = planLabReply(labScenario("weather")).find((step) => step.type === "tool.result")!;
    const asOf = readRunCards(result.payload.cards)[0]!.weather.asOfMs;
    expect(asOf).toBeGreaterThan(before - 60_000);
    expect(asOf).toBeLessThanOrEqual(Date.now());
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

  test("a short text after a tool is readable immediately", () => {
    const plan = planLabReply(labScenario("tools"));
    const firstTextAfterTool = plan.findIndex((step, index) =>
      step.type === "agent.message" && plan.slice(0, index).some((previous) => previous.type === "tool.result"));
    const { assistant } = turnFor("tools", "running", firstTextAfterTool + 1);
    expect(assistant.answer.length).toBeGreaterThan(0);
    expect(assistant.liveNote).toBe("");
    expect(assistant.activity[assistant.activity.length - 1]?.kind).toBe("tool");
  });

  test("the first live sentence is readable before a tool follows", () => {
    const plan = planLabReply(labScenario("tools"));
    const beforeFirstTool = plan.findIndex((step) => step.type === "tool.call");
    const early = turnFor("tools", "running", beforeFirstTool).assistant;
    expect(early.answer).toBe("Je cherche d'abord le test et ses dépendances.");
    expect(early.liveNote).toBe("");
    const afterCall = turnFor("tools", "running", beforeFirstTool + 1).assistant;
    expect(afterCall.liveNote).toBe("");
    expect(afterCall.activity[0]).toMatchObject({ kind: "narration", text: "Je cherche d'abord le test et ses dépendances." });
  });

  test("live text is readable from its first fragment regardless of shape or length", () => {
    const plan = planLabReply(labScenario("answer"));
    const firstFragment = turnFor("answer", "running", 1).assistant;
    expect(firstFragment.answer.length).toBeGreaterThan(0);
    expect(firstFragment.liveNote).toBe("");
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
