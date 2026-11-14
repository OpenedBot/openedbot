import { describe, expect, test } from "bun:test";
import type { HermesClient } from "@openedbot/hermes";
import { RunTrace } from "@openedbot/platform-observability/run-trace";
import type { WorkerConfig } from "../../src/application/worker-config";
import { createRunState } from "../../src/application/runner/run-state";
import { settleRunError } from "../../src/application/runner/settlement";
import type { RunContext } from "../../src/application/runner/types";

describe("abort settlement lease fence", () => {
  for (const cause of ["idleTimedOut", "runTimedOut", "approvalExpired"] as const) {
    test(`${cause}: a rejected stop intent never reaches Hermes or changes local state`, async () => {
      const context = {
        id: "run-1", organizationId: "org-1", leaseGeneration: 7,
        hermesRunId: "remote-1", externalState: "streaming", remoteStopState: null,
      } as RunContext;
      const state = createRunState(context);
      state[cause] = true;
      state.controller.abort(cause);
      const statements: string[] = [];
      const db = ((strings: TemplateStringsArray) => {
        statements.push(strings.join("?"));
        return Promise.resolve([]);
      }) as unknown as Bun.SQL;
      let stops = 0;
      const client = { async stopRun() { stops++; } } as unknown as HermesClient;
      await settleRunError(db, { workerId: "worker-1" } as WorkerConfig,
        context, client, state, new RunTrace(), new Error("aborted"));
      expect(stops).toBe(0);
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("lease_generation");
      expect(context.externalState).toBe("streaming");
      expect(context.remoteStopState).toBeNull();
    });
  }

  test("an accepted intent sends the stop, then respects a lost confirmation fence", async () => {
    const context = {
      id: "run-1", organizationId: "org-1", leaseGeneration: 7,
      hermesRunId: "remote-1", externalState: "streaming", remoteStopState: null,
    } as RunContext;
    const state = createRunState(context);
    state.idleTimedOut = true;
    state.controller.abort();
    let writes = 0;
    const db = (() => Promise.resolve(++writes === 1 ? [{ id: context.id }] : [])) as unknown as Bun.SQL;
    const stopped: string[] = [];
    const client = { async stopRun(id: string) { stopped.push(id); } } as unknown as HermesClient;
    await settleRunError(db, { workerId: "worker-1" } as WorkerConfig,
      context, client, state, new RunTrace(), new Error("aborted"));
    expect(stopped).toEqual(["remote-1"]);
    expect(writes).toBe(2);
    expect(context.externalState).toBe("stopping");
  });
});
