import { describe, expect, test } from "bun:test";
import { fastPath } from "../scenarios/fast-path";
import { ScenarioRecorder } from "./report";
import type { ScenarioContext } from "./scenario";

function harness(failed = false, missingTrace = false) {
  const rec = new ScenarioRecorder(true);
  let reads = 0, purged = false;
  const timings = { queuedMs: 7, marks: { "worker.claimed": 20, "hermes.post_sent": 100, "hermes.first_text_delta": 400, "openedbot.first_text_published": 410 } };
  const context = {
    rec, model: { provider: "test", model: "test", reasoningEffort: null }, config: { messages: 1, keep: false },
    lab: {
      create: async () => ({ id: "bot-owned", threadId: "thread-owned" }), setModel: async () => {},
      waitProvision: async () => ({ status: "succeeded" }),
      send: async () => ({ runId: "run-owned", t0: 1000, acceptedMs: 20,
        marks: { firstEvent: 1020, firstText: failed ? undefined : 1500, terminal: 1600, terminalType: failed ? "run.error" : "run.completed" },
        run: { status: failed ? "failed" : "completed", createdAt: new Date(1000), startedAt: new Date(1400) } }),
      run: async () => {
        if (failed) throw new Error("A failed inference must not wait for text timings");
        reads++;
        if (missingTrace) return null;
        return { leaseGeneration: "2", timings: { ...timings, attributes: { lease_generation: reads === 1 ? 1 : 2 } } };
      },
      answered: async () => true,
      purge: async () => { purged = true; return { cleanup: "succeeded", verifyPasses: 0 }; },
    },
  } as unknown as ScenarioContext;
  return { context, rec, reads: () => reads, purged: () => purged };
}

describe("fast-path trace evidence", () => {
  test("waits for the current lease and reports the real queue separately from preparation", async () => {
    const h = harness(); await fastPath.run(h.context);
    expect(h.reads()).toBe(2);
    expect(h.rec.bench?.rows[0]).toMatchObject({ queuedMs: 7, beforeRuntimeMs: 80, runtimeFirstTextMs: 300, publishTextMs: 10, firstTextMs: 500 });
    expect(h.rec.steps.every((step) => step.status === "pass")).toBe(true);
    expect(h.purged()).toBe(true);
  });

  test("retains a failed sample and its inference error without polling for nonexistent text", async () => {
    const h = harness(true); await fastPath.run(h.context);
    expect(h.reads()).toBe(0);
    expect(h.rec.bench?.rows[0]).toMatchObject({ status: "failed", queuedMs: null, firstTextMs: null });
    expect(h.rec.steps.find((step) => step.name === "Message 1")?.note).toContain("run.error");
    expect(h.purged()).toBe(true);
  });

  test("a trace timeout retains client timings, missing stage counts and cleanup", async () => {
    const h = harness(false, true); await fastPath.run(h.context);
    expect(h.rec.bench?.rows).toHaveLength(1);
    expect(h.rec.bench?.rows[0]).toMatchObject({ firstTextMs: 500, completeMs: 600, queuedMs: null, beforeRuntimeMs: null });
    expect(h.rec.bench?.stats.find((stat) => stat.key === "firstTextMs")).toMatchObject({ n: 1, missing: 0 });
    expect(h.rec.bench?.stats.find((stat) => stat.key === "beforeRuntimeMs")).toMatchObject({ n: 0, missing: 1 });
    expect(h.rec.steps.find((step) => step.name === "Message 1")?.note).toContain("did not settle");
    expect(h.purged()).toBe(true);
  }, 10_000);
});
