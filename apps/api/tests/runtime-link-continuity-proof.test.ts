import { expect, test } from "bun:test";
import { appendGatewayFrame, appendParsedGatewayFrame, provePrimaryRunIdentities, proveActiveRestart, type OrderedEvent } from "../../../tests/e2e/runtime-link-continuity-proof";

test("independent SSE accepts ordered data and refuses duplicates, gaps and missing IDs", () => {
  const events: OrderedEvent[] = [];
  expect(() => appendGatewayFrame([], "id: 9\nevent: run.delta\ndata: {}")).toThrow("gap");
  appendGatewayFrame(events, ": heartbeat");
  appendGatewayFrame(events, "id: 1\nevent: run.delta\ndata: {}");
  expect(() => appendGatewayFrame(events, "id: 1\nevent: run.delta\ndata: {}")).toThrow("duplicate");
  expect(() => appendGatewayFrame(events, "id: 3\nevent: run.delta\ndata: {}")).toThrow("gap");
  expect(() => appendGatewayFrame(events, "event: run.delta\ndata: {}")).toThrow("metadata");
  appendGatewayFrame(events, "id: 2\nevent: run.completed\ndata: {}");
  expect(events.map(({ sequence }) => sequence)).toEqual([1, 2]);
});

test("restart proof requires a new boot inside the observed same active remote run", () => {
  const input = { previousBoot: "2026-09-05T12:00:00Z", currentBoot: "2026-09-05T12:01:00Z", previousActive: true,
    sseStarted: true, runId: "own-run", remoteId: "remote-run", run: {
      startedAt: "2026-09-05T12:00:30Z", endedAt: "2026-09-05T12:01:30Z", hermesResponseId: "remote-run",
    } };
  expect(proveActiveRestart(input).runId).toBe("own-run");
  expect(() => proveActiveRestart({ ...input, currentBoot: input.previousBoot })).toThrow("boot identity");
  expect(() => proveActiveRestart({ ...input, previousActive: false })).toThrow("overlap");
  expect(() => proveActiveRestart({ ...input, sseStarted: false })).toThrow("SSE");
  expect(() => proveActiveRestart({ ...input, run: { ...input.run, endedAt: "2026-09-05T12:00:59Z" } })).toThrow("overlap");
  expect(() => proveActiveRestart({ ...input, run: { ...input.run, hermesResponseId: "different" } })).toThrow("identity");
});

test("real Hermes semantic JSON events retain strict sequence and explicit gap rejection", () => {
  const events: OrderedEvent[] = [];
  appendParsedGatewayFrame(events, { id: "1", event: "message", data: '{"event":"run.started"}' });
  appendParsedGatewayFrame(events, { id: "2", event: "message", data: '{"event":"run.completed"}' });
  expect(events.map((event) => event.type)).toEqual(["run.started", "run.completed"]);
  expect(() => appendParsedGatewayFrame([], { id: null, event: "replay-gap", data: "{}" })).toThrow("replay-gap");
  expect(() => appendParsedGatewayFrame([], { id: null, event: "journal-truncated", data: "{}" })).toThrow("journal-truncated");
  expect(() => appendParsedGatewayFrame([], { id: null, event: "message", data: '{"event":"run.started"}' })).toThrow("ordered journal metadata");
  expect(() => appendParsedGatewayFrame(events, { id: "4", event: "message", data: '{"event":"run.delta"}' })).toThrow("sequence gap");
});

test("primary identity proof recognizes real workflow roots and rejects extra roots", () => {
  expect(() => provePrimaryRunIdentities([{ id: "actual", stepKind: "root" }], ["actual"])).not.toThrow();
  expect(() => provePrimaryRunIdentities([{ id: "legacy", stepKind: null }], ["legacy"])).not.toThrow();
  expect(() => provePrimaryRunIdentities([{ id: "actual", stepKind: "root" }, { id: "unexpected", stepKind: "root" }], ["actual"])).toThrow("duplicated");
  expect(() => provePrimaryRunIdentities([{ id: "different", stepKind: "root" }], ["actual"])).toThrow("identities");
});
