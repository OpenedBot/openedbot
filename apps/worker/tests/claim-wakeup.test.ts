import { describe, expect, test } from "bun:test";
import { createClaimWakeup } from "../src/application/claim-wakeup";

describe("claim wake-up hints", () => {
  test("retains a hint received between an empty claim and entering the wait", async () => {
    const wake = createClaimWakeup();
    const beforeClaim = wake.generation();
    wake.notify();
    const started = performance.now();
    await wake.wait(beforeClaim, 5_000, new AbortController().signal);
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("a hint interrupts an idle wait and the next wait still has its fallback", async () => {
    const wake = createClaimWakeup();
    const controller = new AbortController();
    let finished = false;
    const pending = wake.wait(wake.generation(), 5_000, controller.signal).then(() => { finished = true; });
    expect(finished).toBe(false);
    wake.notify();
    await pending;
    expect(finished).toBe(true);
    const started = performance.now();
    await wake.wait(wake.generation(), 15, controller.signal);
    expect(performance.now() - started).toBeGreaterThanOrEqual(10);
  });

  test("stop releases a waiting loop, including a signal already aborted before the wait", async () => {
    const wake = createClaimWakeup();
    const controller = new AbortController();
    const pending = wake.wait(wake.generation(), 5_000, controller.signal);
    controller.abort();
    await pending;
    const started = performance.now();
    await wake.wait(wake.generation(), 5_000, controller.signal);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
