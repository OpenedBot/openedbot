import { describe, expect, test } from "bun:test";
import type { ScenarioContext } from "./scenario";
import { waitRoutineCancellationGate } from "../scenarios/routines";

const gate = { status: "awaiting_approval", remoteId: "remote-run", gateId: "approval", requestId: "hermes-request", tool: "execute_code" };
function context(rows: Array<Record<string, unknown>>): ScenarioContext {
  let index = 0;
  return {
    session: { organizationId: "owned-organization" }, config: { runTimeoutMs: 20 },
    lab: { db: async () => [rows[Math.min(index++, rows.length - 1)]] },
  } as unknown as ScenarioContext;
}

describe("routine cancellation needs a held real run", () => {
  test("accepts a remotely identified pending execute_code gate on an active run", async () => {
    expect(await waitRoutineCancellationGate(context([gate]), "owned-run")).toEqual(gate);
  });

  test("a completed or ambiguous run cannot masquerade as cancellation evidence", async () => {
    for (const status of ["completed", "failed", "cancelled", "unknown"]) {
      await expect(waitRoutineCancellationGate(context([{ ...gate, status }]), "owned-run")).rejects.toThrow(`Routine ended ${status}`);
    }
  });

  test("waits for remote identity and the intended identified gate instead of cancelling a queued reply", async () => {
    for (const missing of [
      { status: "queued" }, { remoteId: null }, { gateId: null }, { requestId: null }, { tool: "write_file" },
    ]) {
      await expect(waitRoutineCancellationGate(context([{ ...gate, ...missing }]), "owned-run")).rejects.toThrow("Active routine execute_code approval gate");
    }
  });

  test("a disappearing owned run fails with an actionable error", async () => {
    await expect(waitRoutineCancellationGate(context([]), "owned-run")).rejects.toThrow("disappeared before cancellation");
  });
});
