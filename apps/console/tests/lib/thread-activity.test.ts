import { describe, expect, test } from "bun:test";
import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { buildThreadActivity } from "../../src/lib/thread-activity";

const at = new Date("2026-09-03T10:00:00.000Z");
const run = { id: "run-1", status: "completed" } as RunDto;

describe("buildThreadActivity : message d'erreur d'outil", () => {
  test("porte le message d'erreur du tool.result, null quand le runtime s'est tu", () => {
    const events: StoredProductEvent[] = [
      { cursor: 1, sequence: 1, runId: "run-1", type: "tool.call", payload: { toolCallId: "tc_0", tool: "skill_manage" }, occurredAt: at },
      { cursor: 2, sequence: 2, runId: "run-1", type: "tool.result", payload: { toolCallId: "tc_0", tool: "skill_manage", error: true, errorMessage: null }, occurredAt: at },
      { cursor: 3, sequence: 3, runId: "run-1", type: "tool.call", payload: { toolCallId: "tc_1", tool: "terminal" }, occurredAt: at },
      { cursor: 4, sequence: 4, runId: "run-1", type: "tool.result", payload: { toolCallId: "tc_1", tool: "terminal", error: true, errorMessage: "exit 2" }, occurredAt: at },
      { cursor: 5, sequence: 5, runId: "run-1", type: "tool.call", payload: { toolCallId: "tc_2", tool: "execute_code" }, occurredAt: at },
      { cursor: 6, sequence: 6, runId: "run-1", type: "tool.result", payload: { toolCallId: "tc_2", tool: "execute_code", error: true, errorMessage: null }, occurredAt: at },
      { cursor: 7, sequence: 7, runId: "run-1", type: "tool.result.attached", payload: { toolCallId: "tc_2", errorMessage: "Python unavailable", input: "print(1)", result: "failure" }, occurredAt: at },
    ];
    const [activity] = buildThreadActivity([run], events, []);
    expect(activity?.tools.map((tool) => [tool.tool, tool.state, tool.errorMessage])).toEqual([
      ["skill_manage", "failed", null],
      ["terminal", "failed", "exit 2"],
      ["execute_code", "failed", "Python unavailable"],
    ]);
  });
});
