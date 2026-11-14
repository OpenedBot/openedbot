import { expect, test } from "bun:test";
import { settleCleanupWork, type CleanupStore, type CleanupRun, type CleanupWorkflow } from "./cleanup-workflows";
import { cleanupVerdict } from "./bots";

const owner = (botId: string | null = "a", organizationId: string | null = "org") => ({ botId, organizationId });
const run = (id = "root", status = "running", workflowId: string | null = "wf"): CleanupRun => ({ id, status, workflowId, ...owner() });
function fixture() {
  const workflow: CleanupWorkflow = { id: "wf", organizationId: "org", status: "running", rootRunId: "root",
    owners: [owner(), owner("b")], runs: [run(), { ...run("child"), ...owner("b") }] };
  let standalone: CleanupRun | null = null;
  const actions: string[] = [];
  let now = 0;
  const store: CleanupStore = {
    async targets() {
      if (standalone) return ["completed", "failed", "cancelled"].includes(standalone.status) ? [] : [standalone];
      return workflow.status === "cancelled" || (workflow.status === "failed" && workflow.runs.every((r) => r.status === "failed")) ? [] : [workflow.runs[0]!];
    },
    async workflow() { return structuredClone(workflow); },
    async standalone() { return standalone && { run: structuredClone(standalone), owners: [owner()], affectedRuns: [] }; },
  };
  const mutate = async (path: string) => {
    actions.push(path);
    if (path.endsWith("/abandon")) { workflow.status = "failed"; workflow.runs.forEach((r) => r.status = "failed"); }
    else if (standalone) standalone.status = "cancelled";
    else { workflow.status = "cancelled"; workflow.runs.forEach((r) => r.status = "cancelled"); }
  };
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  return { workflow, store, actions, clock, mutate, standalone(value: CleanupRun) { standalone = value; },
    settle: (mutation = mutate, live = new Set(["a", "b"])) => settleCleanupWork(store, mutation, "a", "org", live, 1_000, clock) };
}

test("group cleanup targets workflow and verifies all members before deletion", async () => {
  const f = fixture(); await f.settle();
  expect(f.actions).toEqual(["/api/workflows/wf/cancel"]);
});

test("unknown owned workflow is explicitly abandoned only by cleanup", async () => {
  const f = fixture(); f.workflow.status = "unknown"; f.workflow.runs.forEach((r) => r.status = "unknown");
  await f.settle(); expect(f.actions).toEqual(["/api/workflows/wf/abandon"]);
  // Workflow settlement never substitutes for proof of durable host cleanup.
  expect(cleanupVerdict("queued", "none", true)).toBe("failed");
});

test("active workflow becoming unknown is cancelled then abandoned after settlement", async () => {
  const f = fixture();
  await f.settle(async (path) => {
    if (path.endsWith("/cancel")) { f.actions.push(path); f.workflow.status = "unknown"; f.workflow.runs.forEach((r) => r.status = "unknown"); }
    else await f.mutate(path);
  });
  expect(f.actions).toEqual(["/api/workflows/wf/cancel", "/api/workflows/wf/abandon"]);
});

for (const [label, corrupt] of Object.entries<(f: ReturnType<typeof fixture>) => void>({
  "foreign group member": (f) => { f.workflow.owners.push(owner("foreign")); },
  "null group member": (f) => { f.workflow.owners.push(owner(null)); },
  "missing bot record": (f) => { f.workflow.owners.push(owner("b", null)); },
  "foreign organization": (f) => { f.workflow.runs[1]!.organizationId = "other"; },
  "null run owner": (f) => { f.workflow.runs[1]!.botId = null; },
  "missing root run": (f) => { f.workflow.rootRunId = "missing"; },
  "foreign workflow": (f) => { f.workflow.organizationId = "other"; },
  "wrong run workflow": (f) => { f.workflow.runs[1]!.workflowId = "other"; },
})) test(`refuses ${label} before any mutation`, async () => {
  const f = fixture(); corrupt(f);
  await expect(f.settle()).rejects.toThrow("Cleanup refused"); expect(f.actions).toEqual([]);
});

test("missing workflow and released bot are never authorized", async () => {
  const f = fixture(); f.store.workflow = async () => null;
  await expect(f.settle()).rejects.toThrow("missing or inconsistent");
  const other = fixture(); await expect(other.settle(other.mutate, new Set(["a"]))).rejects.toThrow("ownership");
  expect(f.actions).toEqual([]); expect(other.actions).toEqual([]);
});

test("revalidates ownership immediately before each action", async () => {
  const f = fixture(); let reads = 0;
  f.store.workflow = async () => { if (++reads > 1) f.workflow.owners.push(owner("foreign")); return structuredClone(f.workflow); };
  await expect(f.settle()).rejects.toThrow("ownership"); expect(f.actions).toEqual([]);
});

test("never abandons an unknown workflow while a member is still active", async () => {
  const f = fixture(); f.workflow.status = "unknown"; f.workflow.runs[0]!.status = "unknown";
  await expect(f.settle(async (path) => { f.actions.push(path); })).rejects.toThrow("timed out");
  expect(f.actions).toEqual(["/api/workflows/wf/cancel"]);
});

test("timeout and API failure refuse deletion without duplicate mutation", async () => {
  const f = fixture();
  await expect(f.settle(async (path) => { f.actions.push(path); })).rejects.toThrow("timed out");
  expect(f.actions).toHaveLength(1);
  const rejected = fixture(); await expect(rejected.settle(async () => { throw new Error("API unavailable"); })).rejects.toThrow("API unavailable");
});

test("legitimate standalone run uses the specific run cancellation API", async () => {
  const f = fixture(); f.standalone(run("standalone", "running", null));
  await f.settle(); expect(f.actions).toEqual(["/api/runs/standalone/cancel"]);
});

test("standalone unknown is never abandoned or guessed as a DM", async () => {
  const f = fixture(); f.standalone(run("standalone", "unknown", null));
  await expect(f.settle()).rejects.toThrow("explicit operator reconciliation"); expect(f.actions).toEqual([]);
});

test("new work queued during cleanup blocks subsequent bot deletion", async () => {
  const f = fixture(); const targets = f.store.targets;
  f.store.targets = async (id) => { const result = await targets(id); return result.length ? result : [run("late", "queued", "late-workflow")]; };
  await expect(f.settle()).rejects.toThrow("unsettled work remains");
});


test("standalone courier cannot cancel a foreign handoff child", async () => {
  const f = fixture(); f.standalone(run("courier", "relaying", null));
  f.store.standalone = async () => ({ run: run("courier", "relaying", null), owners: [owner()], affectedRuns: [{ ...run("child"), ...owner("foreign") }] });
  await expect(f.settle()).rejects.toThrow("ownership"); expect(f.actions).toEqual([]);
});

test("standalone waits for all owned courier children after parent stops", async () => {
  const f = fixture(); f.standalone(run("courier", "relaying", null));
  let parent = run("courier", "relaying", null);
  f.store.standalone = async () => ({ run: parent, owners: [owner()], affectedRuns: [{ ...run("child", "running", null), ...owner("b") }] });
  await expect(f.settle(async (path) => { f.actions.push(path); parent = { ...parent, status: "cancelled" }; })).rejects.toThrow("timed out");
  expect(f.actions).toEqual(["/api/runs/courier/cancel"]);
});

test("preflight refuses foreign work in a later workflow before cancelling the first", async () => {
  const f = fixture();
  f.store.targets = async () => [run(), run("second", "running", "foreign-wf")];
  f.store.workflow = async (id) => id === "wf" ? structuredClone(f.workflow) : {
    ...structuredClone(f.workflow), id, rootRunId: "second", owners: [owner("foreign")], runs: [run("second", "running", id)],
  };
  await expect(f.settle()).rejects.toThrow("ownership"); expect(f.actions).toEqual([]);
});

test("ownership is rechecked after cancellation before unknown abandonment", async () => {
  const f = fixture();
  await expect(f.settle(async (path) => {
    f.actions.push(path); f.workflow.status = "unknown";
    f.workflow.runs.forEach((r) => r.status = "unknown"); f.workflow.owners.push(owner("foreign"));
  })).rejects.toThrow("ownership");
  expect(f.actions).toEqual(["/api/workflows/wf/cancel"]);
});

test("failed workflow with an unknown member requires explicit cleanup abandonment", async () => {
  const f = fixture(); f.workflow.status = "failed"; f.workflow.runs.forEach((r) => r.status = "unknown");
  await f.settle(); expect(f.actions).toEqual(["/api/workflows/wf/abandon"]);
});

test("standalone owned child cannot modify a foreign workflow envelope", async () => {
  const f = fixture(); f.standalone(run("courier", "relaying", null));
  f.store.standalone = async () => ({ run: run("courier", "relaying", null), owners: [owner()], affectedRuns: [{ ...run("child"), ...owner("b") }] });
  f.workflow.owners.push(owner("foreign"));
  await expect(f.settle()).rejects.toThrow("ownership"); expect(f.actions).toEqual([]);
});

test("standalone child workflow ownership is reaudited before cancellation", async () => {
  const f = fixture(); f.standalone(run("courier", "relaying", null));
  f.store.standalone = async () => ({ run: run("courier", "relaying", null), owners: [owner()], affectedRuns: [{ ...run("child"), ...owner("b") }] });
  let reads = 0;
  f.store.workflow = async () => { if (++reads > 1) f.workflow.owners.push(owner("foreign")); return structuredClone(f.workflow); };
  await expect(f.settle()).rejects.toThrow("ownership"); expect(f.actions).toEqual([]);
});

test("standalone cancellation waits for related workflow roots without broader mutation", async () => {
  const f = fixture(); f.standalone(run("courier", "relaying", null));
  let parent = run("courier", "relaying", null);
  f.store.standalone = async () => ({ run: parent, owners: [owner()], affectedRuns: [structuredClone(f.workflow.runs[1]!)] });
  await expect(f.settle(async (path) => {
    f.actions.push(path); parent = { ...parent, status: "cancelled" }; f.workflow.runs[1]!.status = "cancelled";
  })).rejects.toThrow("timed out");
  expect(f.actions).toEqual(["/api/runs/courier/cancel"]);
});

test("standalone refuses a missing child workflow before any mutation", async () => {
  const f = fixture(); f.standalone(run("courier", "relaying", null));
  f.store.standalone = async () => ({ run: run("courier", "relaying", null), owners: [owner()], affectedRuns: [{ ...run("child"), ...owner("b") }] });
  f.store.workflow = async () => null;
  await expect(f.settle()).rejects.toThrow("missing or inconsistent"); expect(f.actions).toEqual([]);
});

test("a later courier with mixed workflow blocks an earlier safe workflow mutation", async () => {
  const f = fixture();
  f.store.targets = async () => [run(), run("courier", "relaying", null)];
  f.store.standalone = async () => ({ run: run("courier", "relaying", null), owners: [owner()], affectedRuns: [{ ...run("mixed-child", "running", "mixed"), ...owner("b") }] });
  f.store.workflow = async (id) => id === "wf" ? structuredClone(f.workflow) : {
    id, organizationId: "org", status: "running", rootRunId: "mixed-root", owners: [owner("foreign")],
    runs: [{ ...run("mixed-root", "queued", id), ...owner("foreign") }, { ...run("mixed-child", "running", id), ...owner("b") }],
  };
  await expect(f.settle()).rejects.toThrow("ownership"); expect(f.actions).toEqual([]);
});

for (const defect of ["missing root", "null owner"] as const) test(`standalone child workflow refuses ${defect}`, async () => {
  const f = fixture(); f.standalone(run("courier", "relaying", null));
  f.store.standalone = async () => ({ run: run("courier", "relaying", null), owners: [owner()], affectedRuns: [{ ...run("child"), ...owner("b") }] });
  if (defect === "missing root") f.workflow.rootRunId = "absent";
  else f.workflow.owners.push(owner(null));
  await expect(f.settle()).rejects.toThrow("Cleanup refused"); expect(f.actions).toEqual([]);
});

test("standalone group/thread association requires every boundary owner", async () => {
  const f = fixture(); f.standalone(run("group-speaker", "running", null));
  f.store.standalone = async () => ({ run: run("group-speaker", "running", null), affectedRuns: [], owners: [owner("b"), owner("foreign")] });
  await expect(f.settle()).rejects.toThrow("ownership"); expect(f.actions).toEqual([]);
});
