import { describe, expect, test } from "bun:test";
import { createTestLogger, logEvent, runWithLogger } from "../src/logger";
import {
  childTraceContext,
  currentTrace,
  formatTraceparent,
  newSpanId,
  parseTraceparent,
  runTraceContext,
  runWithTrace,
  traceIdOfRun,
} from "../src/trace-context";

const RUN_ID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";

describe("traceparent (W3C Trace Context)", () => {
  test("reads a version 00 header and writes it back unchanged", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    expect(parseTraceparent(header)).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true });
    expect(formatTraceparent(parseTraceparent(header)!)).toBe(header);
    expect(parseTraceparent(" 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00 ")?.sampled).toBe(false);
  });

  test("ignores every malformed header instead of failing", () => {
    for (const bad of [
      undefined, null, "", "garbage",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01",
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01x",
    ]) expect(parseTraceparent(bad)).toBeNull();
  });

  test("accepts a future version with trailing fields, as the spec asks", () => {
    expect(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future")?.traceId)
      .toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  test("refuses to format an invalid context", () => {
    expect(() => formatTraceparent({ traceId: "0".repeat(32), spanId: "00f067aa0ba902b7", sampled: true })).toThrow();
    expect(() => formatTraceparent({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "xyz", sampled: true })).toThrow();
  });
});

describe("trace of a run", () => {
  test("the trace id is the run UUID without dashes, whatever the process", () => {
    expect(traceIdOfRun(RUN_ID)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(traceIdOfRun(RUN_ID.toUpperCase())).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(runTraceContext(RUN_ID).traceId).toBe(traceIdOfRun(RUN_ID));
  });

  test("an id that is not a UUID still gets a stable, valid trace id", () => {
    expect(traceIdOfRun("run-active")).toBe(traceIdOfRun("run-active"));
    expect(traceIdOfRun("run-active")).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdOfRun("00000000-0000-0000-0000-000000000000")).not.toBe("0".repeat(32));
  });

  test("every claim and every request gets its own span, never zero", () => {
    const claim = runTraceContext(RUN_ID);
    const request = childTraceContext(claim);
    expect(request).toMatchObject({ traceId: claim.traceId, parentSpanId: claim.spanId, sampled: true });
    expect(request.spanId).not.toBe(claim.spanId);
    let calls = 0;
    expect(newSpanId((size) => (calls++ === 0 ? new Uint8Array(size) : new Uint8Array(size).fill(1)))).toBe("0101010101010101");
  });

  test("the context follows awaits, timers and nested calls, and ends with its scope", async () => {
    const context = runTraceContext(RUN_ID);
    expect(currentTrace()).toBeUndefined();
    await runWithTrace(context, async () => {
      await Bun.sleep(1);
      expect(currentTrace()).toBe(context);
      await new Promise<void>((resolve) => setTimeout(() => { expect(currentTrace()).toBe(context); resolve(); }, 1));
    });
    expect(currentTrace()).toBeUndefined();
  });

  test("log lines inside a run carry traceId and spanId; lines outside do not", () => {
    const { logger, records } = createTestLogger();
    const context = runTraceContext(RUN_ID);
    runWithLogger(logger, () => {
      logEvent("api.outside");
      runWithTrace(context, () => {
        logEvent("run.step");
        logEvent("run.request", { spanId: "1111111111111111" });
      });
    });
    expect(records[0]).not.toHaveProperty("traceId");
    expect(records[0]).not.toHaveProperty("spanId");
    expect(records[1]).toMatchObject({ event: "run.step", traceId: context.traceId, spanId: context.spanId });
    expect(records[2]).toMatchObject({ event: "run.request", traceId: context.traceId, spanId: "1111111111111111" });
  });
});
