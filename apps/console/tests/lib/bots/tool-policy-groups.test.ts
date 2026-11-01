import { describe, expect, test } from "bun:test";
import { toolPolicyGroups } from "../../../src/lib/bots/tool-policy-groups";

const at = "2026-10-24T00:00:00.000Z";

describe("toolPolicyGroups", () => {
  test("native writes first, then each MCP server with its tools, every tool following the mode unless stored", () => {
    const groups = toolPolicyGroups(
      [{ toolKey: "patch", policy: "block", updatedAt: at, updatedByKind: "member" }, { toolKey: "mcp:files:delete", policy: "ask", updatedAt: at, updatedByKind: "agency" }],
      [
        { name: "files", enabled: true, transport: "stdio", tools: ["read", "delete", "bad/name"], unreachable: false },
        { name: "calendar", enabled: true, transport: "http", tools: null, unreachable: null },
      ],
    );
    expect(groups.map((group) => (group.kind === "mcp" ? `mcp:${group.server}` : group.kind))).toEqual(["native", "mcp:calendar", "mcp:files"]);
    const native = groups[0]!;
    expect(native.rows.map((row) => row.toolKey)).toEqual(["write_file", "patch", "skill_manage", "send_message", "execute_code"]);
    expect(native.rows.find((row) => row.toolKey === "patch")?.policy).toBe("block");
    expect(native.rows.find((row) => row.toolKey === "write_file")?.policy).toBe("inherit");
    expect(groups[1]!.rows).toEqual([]);
    // A tool name outside the plugin grammar gets no selector.
    expect(groups[2]!.rows.map((row) => [row.label, row.policy])).toEqual([["delete", "ask"], ["read", "inherit"]]);
  });

  test("a stored key no inventory lists stays reachable, so it can return to the mode", () => {
    const groups = toolPolicyGroups([{ toolKey: "mcp:gone:tool", policy: "block", updatedAt: at, updatedByKind: "member" }], null);
    expect(groups.at(-1)).toEqual({ kind: "other", rows: [{ toolKey: "mcp:gone:tool", label: "mcp:gone:tool", native: false, policy: "block" }] });
  });
});
