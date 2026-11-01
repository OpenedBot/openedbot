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

type GoldenCase = { name: string; tool: string; result: { action: string; message: string; rule_key?: string } };

const golden = JSON.parse(readFileSync(edgeSetupPath("test/golden/operator/approval_gates.json"), "utf8")) as GoldenCase[];

const EXPECTED: Record<string, Partial<GateIdentity> & { deletes?: string; opaque?: boolean }> = {
  write_file: { gateKind: "plugin_tool", toolKey: "write_file", deletes: "no", opaque: false },
  write_file_empties: { gateKind: "plugin_tool", toolKey: "write_file", deletes: "yes", opaque: false },
  write_file_sensitive: { gateKind: "plugin_tool", toolKey: "write_file", deletes: "no", opaque: false },
  patch_replace: { gateKind: "plugin_tool", toolKey: "patch", deletes: "no", opaque: false },
  patch_v4a_delete: { gateKind: "plugin_tool", toolKey: "patch", deletes: "yes", opaque: false },
  patch_unreadable: { gateKind: "plugin_tool", toolKey: "patch", deletes: "unknown", opaque: true },
  skill_delete: { gateKind: "plugin_tool", toolKey: "skill_manage", deletes: "yes", opaque: false },
  send_message: { gateKind: "plugin_tool", toolKey: "send_message", deletes: "no", opaque: false },
  execute_code: { gateKind: "plugin_tool", toolKey: "execute_code", deletes: "unknown", opaque: true },
  cronjob: { gateKind: "plugin_tool", toolKey: "cronjob", deletes: "unknown", opaque: false },
  mcp: { gateKind: "plugin_tool", toolKey: "mcp:linear:create_issue", deletes: "unknown", opaque: false },
  mcp_legacy_name: { gateKind: "plugin_tool", toolKey: "mcp:old_server:search", deletes: "unknown", opaque: false },
  mcp_large: { gateKind: "plugin_tool", toolKey: "mcp:linear:create_issue", deletes: "unknown", opaque: true },
  mcp_unregistered: { gateKind: "unknown", toolKey: null },
};

describe("gate identity against the host plugin golden", () => {
  test("the golden covers every expected case, and a blocked tool raises no gate", () => {
    const gates = golden.filter((entry) => entry.result.action === "approve").map((entry) => entry.name);
    expect(gates.sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(golden.find((entry) => entry.name === "blocked")?.result.action).toBe("block");
  });

  test.each(golden.filter((entry) => entry.result.action === "approve").map((entry) => [entry.name, entry] as const))(
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
  });
});
