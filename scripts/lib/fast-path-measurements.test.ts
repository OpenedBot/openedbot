import { describe, expect, test } from "bun:test";
import { createSseReadiness, hasNonEmptyAssistantText, latencyStats, missingLatencyMarks, type LatencyMarks } from "./fast-path-measurements";

describe("fast path measurement coverage", () => {
  const complete: LatencyMarks = { acceptedMs: 0, firstEventMs: 40, firstTextMs: 50, completeMs: 60, queuedMs: 20 };

  test("a completed run with a missing text or event mark is incomplete", () => {
    expect(missingLatencyMarks(complete)).toEqual([]);
    expect(missingLatencyMarks({ ...complete, firstTextMs: null })).toEqual(["firstTextMs"]);
    expect(missingLatencyMarks({ ...complete, firstEventMs: null })).toEqual(["firstEventMs"]);
    expect(missingLatencyMarks({ ...complete, completeMs: NaN, queuedMs: -1 })).toEqual(["completeMs", "queuedMs"]);
  });

  test("percentiles expose incomplete coverage instead of hiding absent runs", () => {
    expect(latencyStats([10, null, 30, Infinity, -1])).toEqual({ n: 2, expected: 5, missing: 3, p50: 10, p95: 30, max: 30 });
    expect(latencyStats([null])).toEqual({ n: 0, expected: 1, missing: 1, p50: null, p95: null, max: null });
  });

  test("structured metadata and empty text do not prove a non-empty reply", () => {
    expect(hasNonEmptyAssistantText([{ type: "text", text: " \n" }])).toBe(false);
    expect(hasNonEmptyAssistantText([{ type: "image", url: "fixture" }])).toBe(false);
    expect(hasNonEmptyAssistantText([{ type: "text", text: "a" }])).toBe(true);
    expect(hasNonEmptyAssistantText("a")).toBe(true);
  });
});

describe("SSE connection readiness", () => {
  test("headers and unrelated frames cannot release the first send", async () => {
    const gate = createSseReadiness();
    let opened = false;
    const ready = gate.wait(1_000).then((value) => { opened = value; return value; });
    gate.observeFrame(': heartbeat 123');
    gate.observeFrame('data: {"type":"agent.message"}');
    await Bun.sleep(10);
    expect(opened).toBe(false);
    gate.observeFrame(": connected");
    expect(await ready).toBe(true);
  });

  test("an absent connection acknowledgement times out and can be retried", async () => {
    const gate = createSseReadiness();
    expect(await gate.wait(10)).toBe(false);
    gate.observeFrame(": connected\r\n");
    expect(await gate.wait(10)).toBe(true);
  });
});
