import { describe, expect, test } from "bun:test";
import { createApprovalForwarder } from "../../src/application/runner/approval-forwarder";

describe("createApprovalForwarder", () => {
  test("forwards on the first trigger and coalesces triggers while the decision is in flight", async () => {
    let resolveForward: (() => void) | null = null;
    let calls = 0;
    const pending = new Promise<void>((resolve) => { resolveForward = resolve; });
    const forwardApproval = createApprovalForwarder(async () => {
      calls += 1;
      await pending;
    });

    const first = forwardApproval();
    await Promise.resolve();
    const second = forwardApproval();

    expect(calls).toBe(1);
    expect(first).toBe(second);
    resolveForward!();
    await Promise.all([first, second]);
    await forwardApproval();
    expect(calls).toBe(2);
  });
});
