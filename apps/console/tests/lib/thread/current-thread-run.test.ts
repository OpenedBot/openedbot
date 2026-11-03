import { describe, expect, test } from "bun:test";
import type { RunDto } from "@openedbot/contracts-api";
import { currentThreadRun, isExecutingThreadRun, isWaitingThreadRun } from "../../../src/lib/thread/current-thread-run";

function run(id: string, status: RunDto["status"]): RunDto {
  return {
    id,
    status,
    input: "",
    output: null,
    usage: null,
    error: null,
    hermesResponseId: null,
    runtimeSession: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    lastEventAt: null,
  };
}

describe("currentThreadRun", () => {
  test("classe les runs en exécution et en attente", () => {
    expect(isExecutingThreadRun({ status: "running" })).toBe(true);
    expect(isWaitingThreadRun({ status: "pending" })).toBe(true);
  });

  test("préfère le run en exécution à un run en file", () => {
    const executing = run("executing", "running");
    expect(currentThreadRun([run("queued", "queued"), executing])?.id).toBe("executing");
  });
});
