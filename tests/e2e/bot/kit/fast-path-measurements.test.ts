import { describe, expect, test } from "bun:test";
import { createSseReadiness, hasCurrentWorkerTimings, hasNonEmptyAssistantText, latencyStats, missingLatencyMarks, workerLatencyBreakdown, type LatencyMarks } from "./fast-path-measurements";

describe("fast path measurement coverage", () => {
  test("a trace from a previous lease is not evidence for a completed retry", () => {
    const timings = { queuedMs: 10, marks: { "worker.claimed": 5, "hermes.post_sent": 100, "hermes.first_text_delta": 500, "openedbot.first_text_published": 510 }, attributes: { lease_generation: 1 } };
    expect(hasCurrentWorkerTimings({ leaseGeneration: 2, timings })).toBe(false);
    expect(hasCurrentWorkerTimings({ leaseGeneration: 2, timings: { ...timings, attributes: { lease_generation: 2 } } })).toBe(true);
    expect(hasCurrentWorkerTimings({ leaseGeneration: "1", timings })).toBe(true);
    expect(hasCurrentWorkerTimings({ leaseGeneration: "invalid", timings })).toBe(false);
    expect(hasCurrentWorkerTimings({ leaseGeneration: "9007199254740992", timings })).toBe(false);
    expect(hasCurrentWorkerTimings({ leaseGeneration: 1, timings: { ...timings, marks: {} } })).toBe(false);
    expect(hasCurrentWorkerTimings(null)).toBe(false);
  });
  test("separates the real queue, worker preparation, runtime and publication", () => {
    const result = workerLatencyBreakdown({ queuedMs: 25.6, marks: {
      "worker.claimed": 100, "hermes.post_sent": 543.7, "hermes.run_created": 611.3,
      "hermes.first_text_delta": 2388.8, "openedbot.first_text_published": 2399.8,
    } });
    expect(result).toMatchObject({ queuedMs: 25.6, publishTextMs: 11 });
    expect(result.beforeRuntimeMs).toBeCloseTo(443.7, 1);
    expect(result.runtimeFirstTextMs).toBeCloseTo(1845.1, 1);
  });

  test("missing or invalid stages stay missing instead of using started_at as a queue metric", () => {
    expect(workerLatencyBreakdown(null)).toEqual({ queuedMs: null, beforeRuntimeMs: null, runtimeFirstTextMs: null, publishTextMs: null });
    expect(workerLatencyBreakdown({ queuedMs: -1, marks: { "hermes.post_sent": 500, "hermes.first_text_delta": 100, "openedbot.first_text_published": NaN } }))
      .toEqual({ queuedMs: null, beforeRuntimeMs: null, runtimeFirstTextMs: null, publishTextMs: null });
    expect(workerLatencyBreakdown({ queuedMs: 10, marks: { "worker.claimed": 600, "hermes.post_sent": 500 } }).beforeRuntimeMs).toBeNull();
  });
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
