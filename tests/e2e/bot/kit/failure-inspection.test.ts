import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectionBeforePurge, waitForFailureInspection, type FailureInspection, type InspectionDependencies } from "./failure-inspection";
const input: FailureInspection = { scenario: "attachments-context", runtime: "750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a", labTag: "abc123", outDir: "tmp/inspection-owned", milliseconds: 600 };
function fixture() {
  let now = 100;
  const calls: string[] = [], sleeps: number[] = [], logs: Array<{ event: string; fields: object }> = [];
  const dependencies: InspectionDependencies = { now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; }, prepare: async () => { calls.push("prepare"); },
    released: async () => false, log: (event, fields) => { logs.push({ event, fields }); } };
  return { dependencies, calls, sleeps, logs };
}
test("default off and successful scenarios perform no inspection but still purge", async () => {
  const f = fixture();
  await inspectionBeforePurge(true, { ...input, milliseconds: 0 }, async () => { f.calls.push("purge"); }, f.dependencies);
  await inspectionBeforePurge(false, input, async () => { f.calls.push("purge"); }, f.dependencies);
  expect(f.calls).toEqual(["purge", "purge"]); expect(f.logs).toEqual([]); expect(f.sleeps).toEqual([]);
});
test("a monotonic deadline bounds the wait without a wall clock or deadline reset", async () => {
  const f = fixture(); await waitForFailureInspection(input, f.dependencies);
  expect(f.sleeps).toEqual([250, 250, 100]);
  expect(f.logs.map((value) => value.event)).toEqual(["failure_inspection_started", "failure_inspection_expired"]);
  for (const { fields } of f.logs) expect(Object.keys(fields).sort()).toEqual(["labTag", "releasePath", "runtime", "scenario"]);
});
test("the per-scenario release sentinel ends inspection before its deadline", async () => {
  const f = fixture(); let reads = 0;
  f.dependencies.released = async (path) => { expect(path).toEndWith("/inspection-attachments-context.release"); return ++reads === 2; };
  await waitForFailureInspection(input, f.dependencies);
  expect(f.sleeps).toEqual([250]); expect(f.logs.at(-1)?.event).toBe("failure_inspection_released");
});
test("real existing release file is observed without waiting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "owned-e2e-inspection-"));
  try { await writeFile(join(directory, "inspection-attachments-context.release"), "");
    let purged = false; await inspectionBeforePurge(true, { ...input, outDir: directory }, async () => { purged = true; }); expect(purged).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
for (const operation of ["prepare", "released", "sleep", "log"] as const) test(`inspection ${operation} failure cannot skip purge`, async () => {
  const f = fixture();
  if (operation === "log") f.dependencies.log = () => { throw new Error("PRIVATE_INSPECTION_DETAIL"); };
  else f.dependencies[operation] = async () => { throw new Error("PRIVATE_INSPECTION_DETAIL"); };
  let purged = 0;
  if (operation === "log") await expect(inspectionBeforePurge(true, input, async () => { purged++; }, f.dependencies)).rejects.toThrow();
  else await inspectionBeforePurge(true, input, async () => { purged++; }, f.dependencies);
  expect(purged).toBe(1); expect(JSON.stringify(f.logs)).not.toContain("PRIVATE_INSPECTION_DETAIL");
  if (operation !== "log") expect(f.logs.at(-1)?.fields).toHaveProperty("reason", operation === "sleep" ? "sleep" : "filesystem");
});
test("invalid duration and traversal never cause a long wait or skip cleanup", async () => {
  for (const patch of [{ milliseconds: -1 }, { milliseconds: 120001 }, { milliseconds: 0.5 }, { scenario: "../foreign" }]) {
    const f = fixture(); let purged = 0;
    await inspectionBeforePurge(true, { ...input, ...patch }, async () => { purged++; }, f.dependencies);
    expect(purged).toBe(1); expect(f.sleeps).toEqual([]); expect(f.calls).toEqual([]);
  }
});


test("early case inspection and runner cleanup share exactly one pause", async () => {
  const f = fixture(); const scope = { ...input, caseKey: {} };
  await waitForFailureInspection(scope, f.dependencies);
  let purged = 0;
  await inspectionBeforePurge(true, scope, async () => { purged++; }, f.dependencies);
  expect(f.sleeps).toEqual([250, 250, 100]); expect(purged).toBe(1);
  const other = { ...input, caseKey: {} };
  await waitForFailureInspection(other, f.dependencies);
  expect(f.sleeps).toEqual([250, 250, 100, 250, 250, 100]);
});
test("failed early inspection is not retried before guaranteed purge", async () => {
  const f = fixture(); const scope = { ...input, caseKey: {} };
  f.dependencies.prepare = async () => { f.calls.push("prepare"); throw new Error("private filesystem error"); };
  let purged = 0;
  await inspectionBeforePurge(true, scope, async () => { purged++; }, f.dependencies);
  await inspectionBeforePurge(true, scope, async () => { purged++; }, f.dependencies);
  expect(f.calls).toEqual(["prepare"]); expect(f.sleeps).toEqual([]); expect(purged).toBe(2);
});
