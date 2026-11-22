import { expect, test } from "bun:test";
import type { HermesEvent } from "@openedbot/hermes";
import { HermesEventNormalizer } from "../src/domain/hermes-events";
import vectors from "../../../protocol/connector/fixtures/run-contract.vectors.json";

for (const vector of vectors.filter((v) => v.kind === "event")) {
  test(`normalizer contract: ${vector.name}`, () => {
    const normalizer = new HermesEventNormalizer();
    const events = [...normalizer.push(vector.payload as HermesEvent), ...normalizer.flush()];
    expect(events.map(({ type, payload }) => ({ type: String(type), payload }))).toEqual(vector.expected!);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    for (const event of events) expect(event.occurredAt.getTime()).toBe(1794873600000);
  });
}

test("tool_call_id pairs out-of-order completions of the same tool", () => {
  const normalizer = new HermesEventNormalizer();
  const started = vectors.find((v) => v.name === "tool.started")!.payload as HermesEvent;
  const completed = vectors.find((v) => v.name === "tool.completed")!.payload as HermesEvent;
  const first = normalizer.push({ ...started, tool_call_id: "one" })[0]!;
  const second = normalizer.push({ ...started, tool_call_id: "two" })[0]!;
  expect(normalizer.push({ ...completed, tool_call_id: "two" })[0]!.payload.toolCallId).toBe(second.payload.toolCallId);
  expect(normalizer.push({ ...completed, tool_call_id: "one" })[0]!.payload.toolCallId).toBe(first.payload.toolCallId);
});
