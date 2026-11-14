import { describe, expect, test } from "bun:test";
import { HermesEventNormalizer } from "../src/domain/hermes-events";

describe("first live text delta", () => {
  test("emits the first fragment immediately with the next durable sequence", () => {
    const normalizer = new HermesEventNormalizer(7, { flushFirstDelta: true });
    expect(normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 1, delta: "Hello" }))
      .toEqual([{ sequence: 7, type: "agent.message", occurredAt: new Date(1000), payload: { text: "Hello" } }]);
    expect(normalizer.hasBufferedDelta).toBe(false);
    expect(normalizer.flush()).toEqual([]);
  });

  test("an empty frame does not consume the first text publication", () => {
    const normalizer = new HermesEventNormalizer(0, { flushFirstDelta: true });
    expect(normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 1, delta: "" })).toEqual([]);
    expect(normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 2, delta: "Hello" })[0])
      .toMatchObject({ sequence: 0, type: "agent.message", occurredAt: new Date(2000), payload: { text: "Hello" } });
  });

  test("coalesces later fragments while keeping their order and monotone sequence", () => {
    const normalizer = new HermesEventNormalizer(7, { flushFirstDelta: true });
    normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 1, delta: "Hello" });
    expect(normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 2, delta: " " })).toEqual([]);
    expect(normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 3, delta: "world" })).toEqual([]);
    expect(normalizer.hasBufferedDelta).toBe(true);
    expect(normalizer.flush()).toEqual([
      { sequence: 8, type: "agent.message", occurredAt: new Date(2000), payload: { text: " world" } },
    ]);
    expect(normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 4, delta: "!" })).toEqual([]);
    const completed = normalizer.push({ event: "run.completed", run_id: "run-1", timestamp: 5, output: "Hello world!" });
    expect(completed[0]).toMatchObject({ sequence: 9, type: "agent.message", payload: { text: "!" } });
    expect(completed[1]).toMatchObject({ sequence: 10, type: "run.completed" });
    expect(normalizer.hasBufferedDelta).toBe(false);
  });

  test("keeps the existing buffered contract for consumers that do not opt in", () => {
    const normalizer = new HermesEventNormalizer();
    expect(normalizer.push({ event: "message.delta", run_id: "run-1", timestamp: 1, delta: "Hello" })).toEqual([]);
    expect(normalizer.hasBufferedDelta).toBe(true);
    expect(normalizer.flush()[0]).toMatchObject({ sequence: 0, payload: { text: "Hello" } });
  });
});
