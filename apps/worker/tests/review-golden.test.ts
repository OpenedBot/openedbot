/**
 * PERM2 v2, golden differential of the automatic reviewer (PERM2-6/7/9):
 * every verdict it writes, every escalation, every "Never wait" refusal, the
 * rules it hands the model and the decision it logs must be the same in solo
 * (no plug-in) and with the plug-in `permissions` installed but
 * `permissions.v2` off, down to the last field. The expected outputs are
 * stored in `fixtures/review-golden.json`, first written from the reviewer as
 * it was before its rule and "Never wait" reads went through the
 * `PermissionRuleSource` port; a single difference fails. Regenerate only on
 * purpose: `UPDATE_REVIEW_GOLDEN=1 bun test`.
 *
 * The cases cross the preflight (pipeline, budget, review proof, circuit,
 * runtime, bot, gate kind, model assignment), the rules (none, `adds`,
 * `replaces`, no policy row, a secret and an overflow), every reviewer
 * behaviour (verdicts, unreadable, failed, cancelled, timeout, busy, a stale
 * profile, a client error), attended with and without a workflow and
 * unattended, and a write that wins or loses its claim. Only what leaves the
 * reviewer is recorded: the model calls, the writes and the log line.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HermesClientError } from "@openedbot/hermes";
import { loadProPlugins, type PermissionRuleSource as ContractRuleSource, type ProPlugin } from "@openedbot/platform-plugins";
import { reviewGate, type ReviewDeps, type ReviewJob } from "@openedbot/execution/application/approval-review";
import { installPermissionRuleSelector } from "@openedbot/execution/application/runner/permission-rule-sources";
import { permissionRuleSelector } from "../src/application/pro-plugins";
import { differingCases, readGoldenFile, writeGoldenFile } from "./golden-store";

const GOLDEN_PATH = join(import.meta.dir, "fixtures/review-golden.json");
const ORG = "org-client";
const BOT = "bot-1";
const WORKFLOW = "wf-1";
const CREATED_AT = Date.parse("2026-10-28T10:00:00.000Z");

type RuleRow = { scope: "bot" | "organization"; kind: string; text: string };
type DbState = {
  proven: boolean;
  circuit: Array<string | null>;
  rulesMode: string | null | undefined;
  rules: RuleRow[];
  workflow: { neverWait: boolean } | null;
  writeWins: boolean;
};

type Preflight = { job?: Partial<ReviewJob>; db?: Partial<DbState>; ageMs?: number };
const PREFLIGHTS: Record<string, Preflight> = {
  ok: {},
  pipeline_legacy: { job: { pipeline: "legacy" } },
  budget_spent: { ageMs: 15_000 },
  budget_almost_spent: { ageMs: 14_500 },
  unproven: { db: { proven: false } },
  circuit_open: { db: { circuit: ["deny", "deny", "deny"] } },
  circuit_broken_by_once: { db: { circuit: ["deny", "once", "deny"] } },
  circuit_two_denials: { db: { circuit: ["deny", "deny"] } },
  runtime_missing: { job: { runtime: null } },
  bot_missing: { job: { botId: null } },
  terminal_gate: { job: { gateKind: "terminal_danger", toolKey: null, gateArgs: { command: "rm -rf build" }, command: "rm -rf build" } },
  global_assignment: { job: { assignmentMode: "global", selectedProvider: "openrouter", selectedModel: "global-model", selectedReasoningEffort: "high" } },
};

const rule = (scope: RuleRow["scope"], kind: string, text: string): RuleRow => ({ scope, kind, text });
const MIXED: RuleRow[] = [
  rule("organization", "allow", "Reading the shared drive is fine."),
  rule("bot", "ask_first", "Ask before writing outside /root/reports."),
  rule("bot", "allow", "Creating Linear issues in the OPS team is fine."),
  rule("organization", "ask_first", "Ask before any message to a customer."),
];
const RULE_STATES: Record<string, Pick<DbState, "rulesMode" | "rules">> = {
  none: { rulesMode: "adds", rules: [] },
  adds_mixed: { rulesMode: "adds", rules: MIXED },
  replaces_mixed: { rulesMode: "replaces", rules: MIXED },
  no_policy_row_mixed: { rulesMode: undefined, rules: MIXED },
  secret_and_overflow: {
    rulesMode: "adds",
    rules: [
      rule("bot", "allow", "Use the token sk-live-0123456789abcdefghijklmnop for the billing API."),
      rule("organization", "teleport", "An unknown kind."),
      ...Array.from({ length: 90 }, (_, at) => rule(at % 2 ? "bot" : "organization", at % 3 ? "allow" : "ask_first", `Rule ${at} ${"x".repeat(at * 7)}`)),
    ],
  },
};

type ClientScript = {
  busy?: number;
  status?: Array<{ status: string; output?: string | null }>;
  createError?: Error;
  statusError?: Error;
  staleProfile?: boolean;
  uncoveredRootServer?: boolean;
};
const completed = (output: string | null) => ({ status: "completed", output });
const CLIENTS: Record<string, ClientScript> = {
  approve: { status: [{ status: "running" }, completed('{"verdict":"approve","reason":"Fits the goal."}')] },
  deny: { status: [completed('{"verdict":"deny","reason":"Not what was asked."}')] },
  escalate: { status: [completed('{"verdict":"escalate","reason":"Unclear, ask the operator."}')] },
  unreadable: { status: [completed("I think it is fine?")] },
  empty_output: { status: [completed(null)] },
  failed: { status: [{ status: "running" }, { status: "failed" }] },
  cancelled: { status: [{ status: "cancelled" }] },
  timeout: { status: [] },
  busy: { busy: Number.POSITIVE_INFINITY },
  busy_then_approve: { busy: 2, status: [completed('{"verdict":"approve","reason":"ok"}')] },
  stale_profile: { staleProfile: true, status: [completed('{"verdict":"approve","reason":"ok"}')] },
  uncovered_root_server: { uncoveredRootServer: true, status: [completed('{"verdict":"approve","reason":"ok"}')] },
  hermes_error: { createError: new HermesClientError("boom", 502, "HERMES_UNAVAILABLE" as never) },
  status_error: { statusError: new Error("socket closed") },
};

const ATTENDANCE: Record<string, { workflowId: string | null; neverWait: boolean }> = {
  attended_no_workflow: { workflowId: null, neverWait: false },
  attended_workflow: { workflowId: WORKFLOW, neverWait: false },
  unattended_workflow: { workflowId: WORKFLOW, neverWait: true },
};

function baseJob(): ReviewJob {
  return {
    id: "gate-1", organizationId: ORG, runId: "run-1", botId: BOT, claimToken: "claim-1",
    createdAt: new Date(CREATED_AT), gateKind: "plugin_tool", toolKey: "write_file",
    gateArgs: { deletes: false, opaque: false, args: { path: "/root/reports/week.md" } },
    command: null, description: "Write the weekly report", goal: "Write this week's report in /root/reports.",
    workflowId: null, neverWait: false, pipeline: "v2", botModel: "bot-model", botReasoningEffort: "medium",
    assignmentMode: "per_bot", selectedProvider: null, selectedModel: null, selectedReasoningEffort: null,
    runtime: { runtimeId: "rt-1", reachability: "public", runtimeEndpoint: "https://edge.test" } as never,
  } as ReviewJob;
}

/** A timestamp taken now is no part of a decision: recorded as `<date>`. */
const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value, function (this: Record<string, unknown>, key, inner) {
  return this[key] instanceof Date ? "<date>" : inner;
}));

function fakeDb(state: DbState, writes: unknown[]): SQL {
  const tenant: string[] = [];
  const query = (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.includes("current_setting('app.organization_id'")) return Promise.resolve([{ previous: tenant.at(-1) ?? "" }]);
    if (text.includes("set_config('app.organization_id'")) { tenant.push(String(parameters[0])); return Promise.resolve([{ set_config: parameters[0] }]); }
    if (text.startsWith("update approval_requests")) {
      writes.push({ write: "approval_requests", sql: text, parameters: clean(parameters) });
      return Promise.resolve(state.writeWins ? [{ id: "gate-1" }] : []);
    }
    if (text.startsWith("update workflows")) {
      writes.push({ write: "workflows", sql: text, parameters: clean(parameters) });
      return Promise.resolve([]);
    }
    if (text.includes("from runtime_review_profiles")) return Promise.resolve([{ proven: state.proven }]);
    if (text.includes("from approval_requests") && text.includes("selected_choice as choice")) {
      return Promise.resolve(state.circuit.map((choice) => ({ choice })));
    }
    if (text.includes("from organization_permission_policies")) {
      return Promise.resolve(state.rulesMode === undefined ? [] : [{ rulesMode: state.rulesMode }]);
    }
    if (text.includes("from bot_permission_rules")) {
      // Tenant-scoped for the worker (0145): unbound, the policy shows nothing.
      return Promise.resolve(tenant.at(-1) === ORG && parameters[0] === ORG ? state.rules.map((row) => ({ ...row })) : []);
    }
    if (text.includes("from runs") && text.includes("for update")) return Promise.resolve([{ id: "run-1" }]);
    if (text.includes("from workflows")) {
      return Promise.resolve(state.workflow && parameters[1] === WORKFLOW ? [{ id: WORKFLOW, neverWait: state.workflow.neverWait }] : []);
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return Object.assign(query, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(query) }) as unknown as SQL;
}

function fakeDeps(script: ClientScript, now: { at: number }, calls: unknown[], inputs: string[]): ReviewDeps {
  let busy = script.busy ?? 0;
  let polls = 0;
  return {
    now: () => now.at,
    sleep: async (ms) => { now.at += ms; },
    client: (runtime) => ({
      mcpInventory: async () => ({ platform: "api_server", servers: [{ name: "linear" }, ...(script.uncoveredRootServer ? [{ name: "drive" }] : [])], catalog: [] }) as never,
      hostProfileInventory: async () => ({ profiles: [{ name: "ohb-reviewer", mcpServers: [{ name: "linear", enabled: script.staleProfile === true }] }] }) as never,
      createRun: async ({ signal: _signal, ...input }) => {
        // The input (rules included) is stored once per distinct value, apart;
        // the abort signal is plumbing, not part of what the model is asked.
        const stored = JSON.stringify(clean(input));
        if (!inputs.includes(stored)) inputs.push(stored);
        calls.push({ call: "createRun", runtime: (runtime as { runtimeId?: string }).runtimeId, input: inputs.indexOf(stored) });
        if (script.createError) throw script.createError;
        if (busy > 0) { busy -= 1; throw new HermesClientError("busy", 429, "HERMES_LIMIT_REACHED" as never); }
        return "hermes-run-1";
      },
      getRunStatus: async (id) => {
        if (script.statusError) throw script.statusError;
        const status = script.status?.[Math.min(polls, script.status.length - 1)] ?? { status: "running" };
        polls += 1;
        calls.push({ call: "getRunStatus", id, polls });
        return { status: status.status, output: status.output ?? null } as never;
      },
      stopRun: async (id) => { calls.push({ call: "stopRun", id }); return undefined as never; },
      deleteSession: async (id) => { calls.push({ call: "deleteSession", id }); return undefined as never; },
    }),
  };
}

async function runCase(preflight: Preflight, rules: Pick<DbState, "rulesMode" | "rules">, script: ClientScript, attendance: { workflowId: string | null; neverWait: boolean }, writeWins: boolean): Promise<string[]> {
  const state: DbState = {
    proven: true, circuit: [], ...rules,
    workflow: attendance.workflowId ? { neverWait: attendance.neverWait } : null,
    writeWins, ...preflight.db,
  };
  // The job still carries the claim's snapshot; the database says the same.
  const job = { ...baseJob(), workflowId: attendance.workflowId, neverWait: attendance.neverWait, ...preflight.job };
  const now = { at: CREATED_AT + (preflight.ageMs ?? 1_000) };
  const writes: unknown[] = [];
  const calls: unknown[] = [];
  const logs: unknown[] = [];
  const inputs: string[] = [];
  const info = console.info;
  console.info = (line: unknown) => { logs.push(typeof line === "string" ? JSON.parse(line) : line); };
  try {
    await reviewGate(fakeDb(state, writes), job as ReviewJob, fakeDeps(script, now, calls, inputs));
  } finally {
    console.info = info;
  }
  return [inputs.length > 0 ? inputs.join("\n") : "(no model call)", JSON.stringify(calls), JSON.stringify(writes), JSON.stringify(logs)];
}

async function verdicts(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [preflightName, preflight] of Object.entries(PREFLIGHTS)) {
    for (const [rulesName, rules] of Object.entries(RULE_STATES)) {
      for (const [clientName, script] of Object.entries(CLIENTS)) {
        for (const [attendanceName, attendance] of Object.entries(ATTENDANCE)) {
          for (const writeWins of [true, false]) {
            out[`${preflightName}|${rulesName}|${clientName}|${attendanceName}|${writeWins ? "won" : "lost"}`] =
              await runCase(preflight, rules, script, attendance, writeWins);
          }
        }
      }
    }
  }
  return out;
}

const CASE_COUNT = Object.keys(PREFLIGHTS).length * Object.keys(RULE_STATES).length * Object.keys(CLIENTS).length * Object.keys(ATTENDANCE).length * 2;

/** A source that would change many verdicts if the reviewer ever read it. */
const POISONED: ContractRuleSource = {
  read: async () => ({
    organizationPolicy: { ceiling: "bypass", enforceReview: false, commandBlocklist: ["ls"] },
    toolPolicy: "always",
    grants: { grantId: "99999999-0000-4000-8000-000000000000", terminalAlways: true },
  }),
  reviewRules: async () => ({ rulesMode: "adds", rules: [{ scope: "bot", kind: "allow", text: "Anything goes." }] }),
  unattended: async () => true,
};

async function installPermissionsPlugin(
  entitlementsFor: (organizationId: string) => Promise<readonly string[]>,
  permissionRules: ContractRuleSource = POISONED,
): Promise<readonly ProPlugin[]> {
  const plugin: ProPlugin = {
    manifest: { id: "permissions", version: "0.0.0-test", pluginApi: 1, entitlements: ["permissions.v2"] },
    hooks: { entitlementsFor },
    permissionRules,
  };
  const loaded = await loadProPlugins(["@openedbot/permissions/plugin"], { importer: async () => ({ default: plugin }), warn: (skip) => { throw new Error(skip.reason); } });
  expect(loaded.plugins.map((entry) => entry.manifest.id)).toEqual(["permissions"]);
  return loaded.plugins;
}

const failures: unknown[] = [];
afterAll(() => installPermissionRuleSelector(null));

describe("review golden: solo and permissions.v2 off review the same", () => {
  test("solo (no plug-in) matches the stored golden", async () => {
    installPermissionRuleSelector(null);
    const solo = await verdicts();
    if (process.env.UPDATE_REVIEW_GOLDEN === "1" || !existsSync(GOLDEN_PATH)) writeGoldenFile(GOLDEN_PATH, solo, { recorded: ["model inputs", "calls", "writes", "logs"] });
    const golden = readGoldenFile(GOLDEN_PATH);
    expect(Object.keys(golden).length).toBe(CASE_COUNT);
    expect(differingCases(solo, golden)).toEqual([]);
  });

  test("the plug-in permissions installed, permissions.v2 off: the same golden", async () => {
    const plugins = await installPermissionsPlugin(async () => []);
    installPermissionRuleSelector(permissionRuleSelector(plugins), (error) => failures.push(error));
    expect(differingCases(await verdicts(), readGoldenFile(GOLDEN_PATH))).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("a plug-in whose entitlement hook throws keeps the core rules too", async () => {
    const plugins = await installPermissionsPlugin(async () => { throw new Error("hook down"); });
    installPermissionRuleSelector(permissionRuleSelector(plugins), () => undefined);
    expect(differingCases(await verdicts(), readGoldenFile(GOLDEN_PATH))).toEqual([]);
  });

  test("permissions.v2 on: the plug-in's review rules and \"Never wait\" really reach the reviewer", async () => {
    const plugins = await installPermissionsPlugin(async (organizationId) => (organizationId === ORG ? ["permissions.v2"] : []));
    installPermissionRuleSelector(permissionRuleSelector(plugins));
    const changed = differingCases(await verdicts(), readGoldenFile(GOLDEN_PATH));
    // The rules: the model is asked under the plug-in's.
    expect(changed.some((key) => key.startsWith("ok|none|approve|attended_no_workflow|"))).toBe(true);
    // "Never wait": an attended workflow's escalation becomes a refusal.
    expect(changed.some((key) => key.startsWith("ok|none|escalate|attended_workflow|"))).toBe(true);
    // No workflow, nothing to read; no bot, no rules; legacy, no model call.
    expect(changed.some((key) => key.startsWith("bot_missing|") && key.includes("|attended_no_workflow|"))).toBe(false);
    expect(changed.some((key) => key.startsWith("pipeline_legacy|") && !key.includes("|attended_workflow|"))).toBe(false);
  });

  test("permissions.v2 on with a source that only reads gate rules: the core's for the rest", async () => {
    const plugins = await installPermissionsPlugin(async () => ["permissions.v2"], { read: POISONED.read });
    installPermissionRuleSelector(permissionRuleSelector(plugins));
    expect(differingCases(await verdicts(), readGoldenFile(GOLDEN_PATH))).toEqual([]);
  });

  test("the golden sees every branch: verdicts, escalations, unattended refusals, lost claims", () => {
    const outputs = Object.values(readGoldenFile(GOLDEN_PATH)).map((row) => row.join("\n"));
    for (const needle of ["decision_stage = 'review'", "'awaiting_human'", "decision_stage = 'unattended'", "update workflows", '"written":false', '"rules":0', '"errorStatus":502']) {
      expect(outputs.some((output) => output.includes(needle))).toBe(true);
    }
  });
});
