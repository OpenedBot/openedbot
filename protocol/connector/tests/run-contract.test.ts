import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vectors from "../fixtures/run-contract.vectors.json";
import { isRunContractPayload, RUN_EVENT_TYPES, RUN_STATUSES, RUN_CONTRACT_ROUTES, runContractRoute, type RunContractPayload } from "../src/run-contract";

for (const vector of vectors) {
  test(`run contract: ${vector.name}`, () => {
    expect(isRunContractPayload(vector.kind as RunContractPayload, vector.payload)).toBe(true);
    expect(isRunContractPayload(vector.kind as RunContractPayload, null)).toBe(false);
    expect(isRunContractPayload(vector.kind as RunContractPayload, [])).toBe(false);
  });
}

test("fixtures cover every consumed event and run status", () => {
  expect(new Set(vectors.filter((v) => v.kind === "event").map((v) => (v.payload as { event: string }).event)))
    .toEqual(new Set(RUN_EVENT_TYPES));
  expect(vectors.filter((v) => v.kind === "run-status").map((v) => (v.payload as { status: string }).status))
    .toEqual([...RUN_STATUSES]);
});

test("reject malformed boundary fields", () => {
  const bad: Array<[RunContractPayload, unknown]> = [
    ["event", { event: "message.delta", run_id: "x", timestamp: Infinity, delta: "hi" }],
    ["event", { event: "message.delta", run_id: "x", timestamp: 1, delta: 12 }],
    ["event", { event: "tool.started", run_id: "x", timestamp: 1, tool: "echo", tool_call_id: "x".repeat(201) }],
    ["event", { event: "approval.request", run_id: "x", timestamp: 1, request_id: "gate", command: "echo", description: "Echo", choices: ["invented"] }],
    ["run-create", { run_id: "" }],
    ["run-status", { status: "complete" }],
    ["run-status", { status: "completed" }],
    ["run-status", { status: "running", usage: { input_tokens: -1 } }],
    ["approval", { request_id: "gate", execution_generation: -1, choice: "once" }],
    ["approval", { request_id: "gate", execution_generation: 1, choice: "once", approved: true }],
    ["session-create", { id: "x", title: false }],
    ["capabilities", { endpoints: { run_steer: [] } }],
    ["toolsets", { data: [{}] }],
    ["model-options", { providers: [{ slug: "fake" }] }],
  ];
  for (const [kind, payload] of bad) expect(isRunContractPayload(kind, payload)).toBe(false);
});

test("route list matches method, profile prefix and query without accepting other routes", () => {
  expect(runContractRoute("GET", "/p/agent-local/v1/runs/run-1/events?since=2")?.mandatory).toBe(true);
  expect(runContractRoute("GET", "/api/sessions/s/messages?limit=128")?.mandatory).toBe(false);
  expect(runContractRoute("DELETE", "/v1/runs/run-1")).toBeUndefined();
  expect(runContractRoute("GET", "/v1/runs/run-1/extra/events")).toBeUndefined();
});


test("every machine-readable route is documented in the execution section", () => {
  const spec = readFileSync(new URL("../../SPEC.md", import.meta.url), "utf8")
    .split("## Contrat d'exécution")[1]!.split("## Rejeu des événements")[0]!;
  for (const route of RUN_CONTRACT_ROUTES) expect(spec).toContain(`${route.method} ${route.path}`);
});
