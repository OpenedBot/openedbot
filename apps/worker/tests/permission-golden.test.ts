/**
 * PERM2 v2, golden differential: every gate decision the core takes must be
 * the same in solo (no plug-in) and with the plug-in `permissions` installed
 * but `permissions.v2` off, down to the last field. The expected outputs are
 * stored in `fixtures/permission-golden.json`, first written from the gate
 * as it was before the `PermissionRuleSource` port; a single difference
 * fails. Regenerate only on purpose: `UPDATE_PERMISSION_GOLDEN=1 bun test`.
 *
 * The cases cross real organization states (solo legacy, v2 in every mode,
 * a ceiling, enforced review, a blocklist, tool policies block / ask /
 * always / unknown, active, revoked and expired grants, the terminal
 * switch, a bot or an organization gone) with every gate the host plugin really raises
 * (edge-setup golden, read through `readGateIdentity`), terminal commands
 * and an unidentified gate, attended and unattended, then the forwarding
 * check of each answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installApprovalReviewer } from "@openedbot/runtimes/application/approval-reviewer";
import type { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProPlugins, type PermissionRuleSource as ContractRuleSource, type ProPlugin } from "@openedbot/platform-plugins";
import { checkBeforeForwardTx, resolveGateTx } from "@openedbot/execution/application/runner/permission-gate";
import { installPermissionRuleSelector } from "@openedbot/execution/application/runner/permission-rule-sources";
import { readGateIdentity, type GateIdentity } from "@openedbot/execution/domain/gate-identity";
import type { PermissionRuleSource as CoreRuleSource } from "@openedbot/execution/domain/permission-rules";
import { edgeSetupPath } from "../../../tests/edge-setup-dir";
import { permissionRuleSelector } from "../src/application/pro-plugins";

// The port of the contract and the one the gate reads are the same type.
const contractIsCore: CoreRuleSource = {} as ContractRuleSource;
const coreIsContract: ContractRuleSource = {} as CoreRuleSource;
void contractIsCore; void coreIsContract;

const GOLDEN_PATH = join(import.meta.dir, "fixtures/permission-golden.json");
const ORG = "org-client";
const BOT = "bot-1";

type Grant = { toolKey: string; status: "active" | "revoked" | "expired"; id: string };
type OrgState = {
  pipeline: string | null;
  bot?: { mode: string; revision: number } | null;
  reviewProven?: boolean;
  orgPolicy?: { ceiling: string | null; enforceReview: boolean; commandBlocklist: unknown };
  toolPolicies?: Record<string, string>;
  grants?: Grant[];
  terminalAlways?: boolean;
};

const grant = (toolKey: string, status: Grant["status"]): Grant =>
  ({ toolKey, status, id: `71000000-0000-4000-8000-${String(toolKey.length).padStart(4, "0")}${status.slice(0, 2)}me0000` });

const v2 = (mode: string, extra: Omit<OrgState, "pipeline" | "bot"> = {}, revision = 3): OrgState =>
  ({ pipeline: "v2", bot: { mode, revision }, reviewProven: true, ...extra });

const STATES: Record<string, OrgState> = {
  solo_legacy: { pipeline: "legacy" },
  unknown_pipeline: { pipeline: "something" },
  organization_gone: { pipeline: null },
  bot_gone: { pipeline: "v2", bot: null },
  v2_manual: v2("manual"),
  v2_plan: v2("plan"),
  v2_auto_proven: v2("auto"),
  v2_auto_unproven: v2("auto", { reviewProven: false }),
  v2_bypass: v2("bypass"),
  v2_unknown_mode: v2("turbo"),
  ceiling_manual_on_bypass: v2("bypass", { orgPolicy: { ceiling: "manual", enforceReview: false, commandBlocklist: [] } }),
  ceiling_auto_on_bypass: v2("bypass", { orgPolicy: { ceiling: "auto", enforceReview: false, commandBlocklist: [] } }),
  ceiling_unknown_on_auto: v2("auto", { orgPolicy: { ceiling: "galaxy", enforceReview: false, commandBlocklist: [] } }),
  enforce_review_on_bypass: v2("bypass", { orgPolicy: { ceiling: null, enforceReview: true, commandBlocklist: [] } }),
  enforce_review_on_auto_with_grant: v2("auto", {
    orgPolicy: { ceiling: null, enforceReview: true, commandBlocklist: [] }, grants: [grant("write_file", "active")],
  }),
  blocklist_on_bypass: v2("bypass", { orgPolicy: { ceiling: null, enforceReview: false, commandBlocklist: ["git push --force", "rm", 42] } }),
  tool_policy_block: v2("bypass", { toolPolicies: { write_file: "block", patch: "block", "mcp:linear:create_issue": "block" } }),
  tool_policy_ask: v2("bypass", { toolPolicies: { write_file: "ask", send_message: "ask", "mcp:linear:create_issue": "ask" } }),
  tool_policy_always_on_auto: v2("auto", { toolPolicies: { write_file: "always", send_message: "always", skill_manage: "always" } }),
  tool_policy_unknown_value: v2("auto", { toolPolicies: { write_file: "sometimes", send_message: "inherit" } }),
  grant_active_member_on_auto: v2("auto", { grants: [grant("write_file", "active"), grant("send_message", "active")] }),
  grants_revoked_or_expired_on_auto: v2("auto", { grants: [grant("write_file", "revoked"), grant("send_message", "expired")] }),
  grant_on_manual: v2("manual", { grants: [grant("write_file", "active")] }),
  terminal_switch_on_auto: v2("auto", { terminalAlways: true }),
  terminal_switch_on_manual: v2("manual", { terminalAlways: true }),
};

const pluginGates: Array<[string, GateIdentity]> = (
  JSON.parse(readFileSync(edgeSetupPath("test/golden/operator/approval_gates.json"), "utf8")) as Array<{ name: string; tool: string; result: { action: string; message: string; rule_key?: string } | null }>
).filter((entry): entry is typeof entry & { result: NonNullable<typeof entry.result> } => entry.result?.action === "approve").map((entry) => [entry.name, readGateIdentity({
  request_id: `req-${entry.name}`, pattern_key: `plugin_rule:${entry.result.rule_key ?? entry.tool}`, description: entry.result.message,
})]);
const terminal = (name: string, command: unknown): [string, GateIdentity] =>
  [`terminal_${name}`, readGateIdentity({ request_id: `req-t-${name}`, pattern_key: "dangerous_command", command })];
const GATES: Array<[string, GateIdentity]> = [
  ...pluginGates,
  terminal("force_push", "git push --force origin main"),
  terminal("force_push_sudo", "FOO=1 sudo git push --force"),
  terminal("rm_file", "rm notes.md"),
  terminal("rm_root", "rm -rf /"),
  terminal("chmod", "chmod 777 build"),
  terminal("too_long", "x".repeat(2001)),
  ["unidentified", readGateIdentity({ request_id: "req-u", pattern_key: "plugin_rule:" })],
];
const CHOICE_SETS: Array<[string, readonly unknown[]]> = [["once_deny", ["once", "deny"]], ["deny_only", ["deny"]]];

function fakeTx(state: OrgState): SQL {
  const tenant: string[] = [];
  return ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.includes("current_setting('app.organization_id'")) return Promise.resolve([{ previous: tenant.at(-1) ?? "" }]);
    if (text.includes("set_config('app.organization_id'")) { tenant.push(String(parameters[0])); return Promise.resolve([{ set_config: parameters[0] }]); }
    const visible = () => tenant.at(-1) === parameters[0];
    if (text.includes("from bot_permission_tool_policies")) {
      const policy = state.toolPolicies?.[String(parameters[2])];
      return Promise.resolve(policy && visible() ? [{ policy }] : []);
    }
    if (text.includes("from bot_permission_grants")) {
      if (!text.includes("status = 'active'")) throw new Error(`grant read without the status filter: ${text}`);
      const match = (state.grants ?? []).find((row) => row.toolKey === parameters[2] && row.status === "active");
      return Promise.resolve(match && visible() ? [{ id: match.id }] : []);
    }
    if (text.includes("from runtime_review_profiles")) return Promise.resolve([{ proven: state.reviewProven === true }]);
    if (text.includes("from runtime_permission_settings")) return Promise.resolve([{ switched: state.terminalAlways === true && visible() }]);
    if (text.includes("from organization_permission_policies")) return Promise.resolve(state.orgPolicy ? [state.orgPolicy] : []);
    if (text.includes("from organizations")) return Promise.resolve(state.pipeline === null ? [] : [{ pipeline: state.pipeline }]);
    if (text.includes("from bots")) return Promise.resolve(state.bot ? [state.bot] : []);
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as SQL;
}

const FORWARDS = [
  [null, "once", 3], ["human", "once", 3], ["human", "deny", 3], ["policy", "once", 3], ["policy", "deny", 2],
] as const;

/** Per case (`state|gate|choices|attendance`): the resolution, then each forwarding check, as comparable strings. */
async function decisions(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [stateName, state] of Object.entries(STATES)) {
    for (const [gateName, gate] of GATES) {
      for (const [choiceName, choices] of CHOICE_SETS) {
        for (const neverWait of [false, true]) {
          const context = { organizationId: ORG, botId: BOT, neverWait };
          const row = [JSON.stringify(await resolveGateTx(fakeTx(state), context, gate, choices))];
          for (const [kind, choice, revisionSeen] of FORWARDS) {
            row.push(JSON.stringify(await checkBeforeForwardTx(fakeTx(state), context, { choice, decidedByKind: kind, revisionSeen, gate, choices })));
          }
          out[`${stateName}|${gateName}|${choiceName}|${neverWait ? "unattended" : "attended"}`] = row;
        }
      }
    }
  }
  return out;
}

/** The stored form: each distinct output once, each case as indices into it. */
type GoldenFile = { forwards: string[]; outputs: string[]; cases: Record<string, number[]> };

function writeGolden(computed: Record<string, string[]>): void {
  const outputs: string[] = [];
  const index = new Map<string, number>();
  const cases: Record<string, number[]> = {};
  for (const [key, row] of Object.entries(computed)) {
    cases[key] = row.map((output) => {
      if (!index.has(output)) { index.set(output, outputs.length); outputs.push(output); }
      return index.get(output)!;
    });
  }
  const forwards = FORWARDS.map(([kind, choice, revision]) => `${kind ?? "none"}-${choice}-r${revision}`);
  const body = [
    "{",
    ` "forwards": ${JSON.stringify(forwards)},`,
    ` "outputs": [\n${outputs.map((output) => `  ${JSON.stringify(output)}`).join(",\n")}\n ],`,
    ` "cases": {\n${Object.entries(cases).map(([key, row]) => `  ${JSON.stringify(key)}: ${JSON.stringify(row)}`).join(",\n")}\n }`,
    "}",
  ].join("\n");
  writeFileSync(GOLDEN_PATH, `${body}\n`);
}

function readGolden(): Record<string, string[]> {
  const file = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
  return Object.fromEntries(Object.entries(file.cases).map(([key, row]) => [key, row.map((at) => file.outputs[at]!)]));
}

const decisionCount = (cases: Record<string, string[]>) => Object.values(cases).reduce((sum, row) => sum + row.length, 0);

/** A source that would change many decisions if the gate ever read it. */
const POISONED: ContractRuleSource = {
  read: async () => ({
    organizationPolicy: { ceiling: "bypass", enforceReview: false, commandBlocklist: ["ls"] },
    toolPolicy: "always",
    grants: { grantId: "99999999-0000-4000-8000-000000000000", terminalAlways: true },
  }),
};

async function installPermissionsPlugin(entitlementsFor: (organizationId: string) => Promise<readonly string[]>): Promise<readonly ProPlugin[]> {
  const plugin: ProPlugin = {
    manifest: { id: "permissions", version: "0.0.0-test", pluginApi: 1, entitlements: ["permissions.v2"] },
    hooks: { entitlementsFor },
    permissionRules: POISONED,
  };
  const loaded = await loadProPlugins(["@openedbot/permissions/plugin"], { importer: async () => ({ default: plugin }), warn: (skip) => { throw new Error(skip.reason); } });
  expect(loaded.plugins.map((entry) => entry.manifest.id)).toEqual(["permissions"]);
  return loaded.plugins;
}

const failures: unknown[] = [];
afterAll(() => installPermissionRuleSelector(null));
// The automatic reviewer is the plug-in `permissions`' (`approvalReviewer`), not
// the core's: these goldens compare rule sources, so they install a test
// reviewer whose readiness is the fake proof, as the gate read it before the
// port. Without any reviewer `auto` acts as `manual` (permission-gate.test.ts).
beforeAll(() => installApprovalReviewer({
  ready: async (tx) => ((await (tx as SQL)`select proven from runtime_review_profiles`) as Array<{ proven: boolean }>)[0]?.proven === true,
}));
afterAll(() => installApprovalReviewer(null));

describe("permission golden: solo and permissions.v2 off decide the same", () => {
  test("solo (no plug-in) matches the stored golden", async () => {
    installPermissionRuleSelector(null);
    const solo = await decisions();
    if (process.env.UPDATE_PERMISSION_GOLDEN === "1" || !existsSync(GOLDEN_PATH)) {
      writeGolden(solo);
    }
    const golden = readGolden();
    expect(Object.keys(golden).length).toBe(Object.keys(STATES).length * GATES.length * CHOICE_SETS.length * 2);
    expect(decisionCount(golden)).toBe(Object.keys(golden).length * (1 + FORWARDS.length));
    expect(solo).toEqual(golden);
  });

  test("the plug-in permissions installed, permissions.v2 off: the same golden", async () => {
    const plugins = await installPermissionsPlugin(async () => []);
    installPermissionRuleSelector(permissionRuleSelector(plugins), (error) => failures.push(error));
    const golden = readGolden();
    expect(await decisions()).toEqual(golden);
    expect(failures).toEqual([]);
  });

  test("a plug-in whose entitlement hook throws keeps the core rules too", async () => {
    const plugins = await installPermissionsPlugin(async () => { throw new Error("hook down"); });
    const seen: unknown[] = [];
    installPermissionRuleSelector(permissionRuleSelector(plugins), (error) => seen.push(error));
    const golden = readGolden();
    expect(await decisions()).toEqual(golden);
    expect(seen.length).toBeGreaterThan(0);
  });

  test("permissions.v2 on: the plug-in's rules really reach the gate (the comparison can see a source)", async () => {
    const plugins = await installPermissionsPlugin(async (organizationId) => (organizationId === ORG ? ["permissions.v2"] : []));
    installPermissionRuleSelector(permissionRuleSelector(plugins));
    const golden = readGolden();
    const enabled = await decisions();
    const changed = Object.keys(golden).filter((key) => JSON.stringify(enabled[key]) !== JSON.stringify(golden[key]));
    expect(changed.length).toBeGreaterThan(0);
    // Legacy organizations never read rules, whatever the source.
    expect(changed.some((key) => key.includes("|solo_legacy|"))).toBe(false);
  });

  test("no plug-in permissions, or one without permissionRules: no selector", () => {
    expect(permissionRuleSelector([])).toBeNull();
  });
});
