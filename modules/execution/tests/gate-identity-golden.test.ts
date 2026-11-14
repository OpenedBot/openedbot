/**
 * The host plugin and this reader are twins. The golden is what the plugin
 * really answers (edge-setup `internal/operator/approval_policy_gate_test.go`
 * writes it); each gate it raises must be identified here exactly as it stands
 * for, the way Hermes forwards it: `pattern_key = "plugin_rule:" + rule_key`
 * (the tool name without one), the message as the description.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readGateIdentity, type GateIdentity } from "../src/domain/gate-identity";
import { edgeSetupPath } from "../../../tests/edge-setup-dir";

type GoldenCase = { name: string; tool: string; result: { action: string; message: string; rule_key?: string } | null };

const golden = JSON.parse(readFileSync(edgeSetupPath("test/golden/operator/approval_gates.json"), "utf8")) as GoldenCase[];

const EXPECTED: Record<string, Partial<GateIdentity> & { deletes?: string; opaque?: boolean }> = {
  write_file: { gateKind: "plugin_tool", toolKey: "write_file", deletes: "no", opaque: false },
  write_file_empties: { gateKind: "plugin_tool", toolKey: "write_file", deletes: "yes", opaque: false },
  write_file_sensitive: { gateKind: "plugin_tool", toolKey: "write_file", deletes: "no", opaque: false },
  patch_replace: { gateKind: "plugin_tool", toolKey: "patch", deletes: "no", opaque: false },
  patch_v4a_delete: { gateKind: "plugin_tool", toolKey: "patch", deletes: "yes", opaque: false },
  patch_unreadable: { gateKind: "plugin_tool", toolKey: "patch", deletes: "unknown", opaque: true },
  skill_single_create_023: { gateKind: "plugin_tool", toolKey: "skill_manage", deletes: "no", opaque: false },
  skill_delete: { gateKind: "plugin_tool", toolKey: "skill_manage", deletes: "yes", opaque: false },
  send_message: { gateKind: "plugin_tool", toolKey: "send_message", deletes: "no", opaque: false },
  execute_code: { gateKind: "plugin_tool", toolKey: "execute_code", deletes: "unknown", opaque: true },
  cronjob: { gateKind: "plugin_tool", toolKey: "cronjob", deletes: "unknown", opaque: false },
  mcp: { gateKind: "plugin_tool", toolKey: "mcp:linear:create_issue", deletes: "unknown", opaque: false },
  mcp_legacy_name: { gateKind: "plugin_tool", toolKey: "mcp:old_server:search", deletes: "unknown", opaque: false },
  mcp_large: { gateKind: "plugin_tool", toolKey: "mcp:linear:create_issue", deletes: "unknown", opaque: true },
  mcp_unregistered: { gateKind: "unknown", toolKey: null },
  routine_create: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_create_long_prompt: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: true },
  routine_list_unclassified_case: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_list_unclassified_type: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_list_unclassified_space: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_list_unclassified_zero_width: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_list_unclassified_title: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_list_unclassified_prefix: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_list_json_string: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  // The registry could not say which server the tool belongs to: no identity, a person decides.
  routine_list_registry_raises: { gateKind: "unknown", toolKey: null },
  routine_no_action: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_no_args: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_routines:routine_manage", deletes: "unknown", opaque: false },
  routine_list_other_server: { gateKind: "plugin_tool", toolKey: "mcp:other:routine_manage", deletes: "unknown", opaque: false },
  bot_settings: { gateKind: "plugin_tool", toolKey: "mcp:openedbot_bot_settings:bot_settings_propose", deletes: "unknown", opaque: false },
};

const approved = golden.filter((entry): entry is GoldenCase & { result: NonNullable<GoldenCase["result"]> } => entry.result?.action === "approve");

describe("gate identity against the host plugin golden", () => {
  test("the golden covers every expected case, and a blocked tool raises no gate", () => {
    const gates = approved.map((entry) => entry.name);
    expect(gates.sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const name of ["blocked", "routine_list_blocked", "routine_create_plan_mode"]) {
      expect(golden.find((entry) => entry.name === name)?.result?.action).toBe("block");
    }
  });

  test("a routine_manage `list` passes without a gate, in plan mode too; nothing else does", () => {
    const ungated = golden.filter((entry) => entry.result === null).map((entry) => entry.name);
    expect(ungated.sort()).toEqual(["routine_list", "routine_list_plan_mode"]);
  });

  test("an openedbot run key never travels in a descriptor; a long prompt gives way to its length", () => {
    expect(JSON.stringify(golden)).not.toContain("run_key");
    expect(JSON.stringify(golden)).not.toContain("FixtureRunKey");
    const long = approved.find((entry) => entry.name === "routine_create_long_prompt")!;
    const gate = readGateIdentity({ request_id: "req", pattern_key: `plugin_rule:${long.result.rule_key}`, description: long.result.message });
    expect((gate.gateArgs as { args: { arguments: Record<string, unknown> } }).args.arguments)
      .toEqual({ action: "create", name: "Weekly review", schedule: "every monday at 9am", timezone: "Europe/Paris", prompt_chars: 900 });
  });

  test.each(approved.map((entry) => [entry.name, entry] as const))(
    "%s",
    (name, entry) => {
      const gate = readGateIdentity({
        request_id: "req",
        pattern_key: `plugin_rule:${entry.result.rule_key ?? entry.tool}`,
        description: entry.result.message,
      });
      const { deletes, opaque, ...identity } = EXPECTED[name]!;
      expect(gate).toMatchObject({ hermesRequestId: "req", ...identity });
      if (deletes !== undefined) expect(gate.gateArgs).toMatchObject({ deletes, opaque });
    },
  );

  test("MCP arguments arrive masked, and a file content never travels", () => {
    expect(JSON.stringify(golden)).not.toContain("sk-fixture");
    expect(JSON.stringify(golden)).not.toContain("ssh-ed25519");
    expect(JSON.stringify(golden)).not.toContain("fixture-secret-content-not-in-descriptor");
  });
});
