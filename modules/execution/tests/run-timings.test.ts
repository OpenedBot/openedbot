import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { saveRunTimings } from "../src/application/run-timings";

describe("saveRunTimings (0151)", () => {
  const run = { id: "run-1", organizationId: "org-1", leaseGeneration: 3 };
  const record = {
    runId: "run-1",
    organizationId: "org-1",
    queuedMs: 12,
    startedAt: "2026-10-27T13:45:26.000Z",
    marks: { "hermes.first_text_delta": 2_100 },
    spans: { "preflight.history": 4.2 },
    attributes: {},
    verdicts: {},
  };

  test("keeps the measures on the run's own row, without repeating its identifiers", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: [...parts].join(" "), values });
      return Promise.resolve([]);
    }) as unknown as SQL;
    await saveRunTimings(db, run, record);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain("update runs set timings =");
    expect(statements[0]!.sql).toContain("organization_id =");
    const saved = statements[0]!.values[0] as Record<string, unknown>;
    expect(saved).not.toHaveProperty("runId");
    expect(saved).not.toHaveProperty("organizationId");
    expect(saved.marks).toEqual({ "hermes.first_text_delta": 2_100 });
    // Bornée au bail : un worker évincé n'écrase pas la mesure de son repreneur.
    expect(statements[0]!.sql).toContain("lease_generation =");
    expect(statements[0]!.values.slice(1)).toEqual(["org-1", "run-1", 3]);
  });

  test("a failed write only logs: it never rejects into the worker loop", async () => {
    const db = (() => Promise.reject(new Error("connection reset"))) as unknown as SQL;
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => { logged.push(line); };
    try {
      await expect(saveRunTimings(db, run, record)).resolves.toBeUndefined();
    } finally {
      console.error = original;
    }
    expect(logged).toEqual([JSON.stringify({ event: "run.timings_write_failed", runId: "run-1" })]);
  });
});
