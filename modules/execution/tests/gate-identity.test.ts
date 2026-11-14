import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GATE_DESCRIPTOR_MAX_BYTES, gateDescriptionText, readGateIdentity } from "../src/domain/gate-identity";
import { HermesEventNormalizer } from "../src/domain/hermes-events";

const DIGEST = "a".repeat(64);

/** The message the host plugin writes: one sentence, then the descriptor line. */
function pluginMessage(descriptor: Record<string, unknown>, tamper?: (text: string) => string): string {
  const text = JSON.stringify(descriptor);
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `Approve write-capable tool ${String(descriptor.tool)}.\nopenedbot-gate/v1 ${digest} ${tamper ? tamper(text) : text}`;
}

function pluginGate(toolKey: string, descriptor: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    request_id: "req-1",
    pattern_key: `plugin_rule:openedbot/v1/${toolKey}`,
    pattern_keys: [`plugin_rule:openedbot/v1/${toolKey}`],
    command: `<${toolKey}> (plugin approval rule)`,
    description: pluginMessage({ v: 1, tool: toolKey, digest: DIGEST, ...descriptor }),
    ...overrides,
  };
}

describe("gate identity", () => {
  test("Hermes 0.23: prompt_id and execution_generation, pattern_key restored by the host hook", () => {
    const raw = pluginGate("write_file", { deletes: "no", opaque: false, args: { path: "notes/todo.md", size: 12 } });
    delete (raw as Record<string, unknown>).request_id;
    const gate = readGateIdentity({ ...raw, prompt_id: "prompt-7", execution_generation: 3 });
    expect(gate).toMatchObject({ hermesRequestId: "prompt-7", hermesExecutionGeneration: 3, gateKind: "plugin_tool", toolKey: "write_file" });
  });

  test("Hermes 0.23 without the host hook: no pattern_key, so unknown, even with a valid descriptor", () => {
    const raw = pluginGate("write_file", { deletes: "no", opaque: false, args: { path: "a", size: 1 } });
    const { pattern_key: _dropped, request_id: _legacy, ...prompt } = raw as Record<string, unknown>;
    expect(readGateIdentity({ ...prompt, prompt_id: "prompt-8", execution_generation: 1 }))
      .toEqual({ hermesRequestId: "prompt-8", hermesExecutionGeneration: 1, gateKind: "unknown", toolKey: null, gateArgs: null, descriptorVersion: null });
  });

  test("a malformed execution_generation reads as a Hermes 0.22 gate", () => {
    for (const execution_generation of [-1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(readGateIdentity({ request_id: "r", execution_generation }).hermesExecutionGeneration).toBeNull();
    }
  });


  test("a described plugin gate is identified with its request id and descriptor", () => {
    const gate = readGateIdentity(pluginGate("write_file", { deletes: "no", opaque: false, args: { path: "notes/todo.md", size: 12 } }));
    expect(gate).toEqual({
      hermesRequestId: "req-1",
      hermesExecutionGeneration: null,
      gateKind: "plugin_tool",
      toolKey: "write_file",
      gateArgs: { tool: "write_file", deletes: "no", opaque: false, digest: DIGEST, args: { path: "notes/todo.md", size: 12 } },
      descriptorVersion: 1,
    });
  });

  test("an MCP gate keeps server and tool, and never claims it does not delete", () => {
    const key = "mcp:github:create_issue";
    const described = { opaque: false, args: { server: "github", tool: "create_issue", arguments: { title: "x" } } };
    expect(readGateIdentity(pluginGate(key, { ...described, deletes: "unknown" })).gateKind).toBe("plugin_tool");
    expect(readGateIdentity(pluginGate(key, { ...described, deletes: "no" })).gateKind).toBe("unknown");
    // Arguments too large to describe: opaque, never silently dropped.
    const opaque = { deletes: "unknown", args: { server: "github", tool: "create_issue" } };
    expect(readGateIdentity(pluginGate(key, { ...opaque, opaque: true })).gateKind).toBe("plugin_tool");
    expect(readGateIdentity(pluginGate(key, { ...opaque, opaque: false })).gateKind).toBe("unknown");
  });

  test("execute_code is described only as opaque", () => {
    const args = { language: "python", size: 300 };
    expect(readGateIdentity(pluginGate("execute_code", { deletes: "unknown", opaque: true, args })).gateKind).toBe("plugin_tool");
    expect(readGateIdentity(pluginGate("execute_code", { deletes: "unknown", opaque: false, args })).gateKind).toBe("unknown");
  });

  test.each([
    ["a pattern key outside the openedbot namespace", { pattern_key: "plugin_rule:write_file" }],
    ["a malformed tool key", { pattern_key: "plugin_rule:openedbot/v1/Write File" }],
    ["a tool outside the closed table", { pattern_key: "plugin_rule:openedbot/v1/browser_click" }],
    ["no descriptor line", { description: "Approve write-capable tool write_file." }],
    ["two descriptor lines", { description: `${pluginMessage({ v: 1, tool: "write_file", deletes: "no", opaque: false, digest: DIGEST, args: { path: "a", size: 1 } })}\nopenedbot-gate/v1 ${DIGEST} {}` }],
    ["a descriptor Hermes redacted", { description: pluginMessage({ v: 1, tool: "write_file", deletes: "no", opaque: false, digest: DIGEST, args: { path: "a", size: 1 } }, (text) => text.replace("\"a\"", "\"***\"")) }],
    ["a descriptor for another tool", { description: pluginMessage({ v: 1, tool: "patch", deletes: "no", opaque: false, digest: DIGEST, args: { paths: [], ops: [] } }) }],
    ["an unknown descriptor version", { description: pluginMessage({ v: 2, tool: "write_file", deletes: "no", opaque: false, digest: DIGEST, args: { path: "a", size: 1 } }) }],
    ["an extra descriptor field", { description: pluginMessage({ v: 1, tool: "write_file", deletes: "no", opaque: false, digest: DIGEST, args: { path: "a", size: 1, content: "x" } }) }],
    ["a write_file that cannot say whether it deletes", { description: pluginMessage({ v: 1, tool: "write_file", deletes: "unknown", opaque: false, digest: DIGEST, args: { path: "a", size: 1 } }) }],
    ["a skill delete not flagged as a deletion", { pattern_key: "plugin_rule:openedbot/v1/skill_manage", description: pluginMessage({ v: 1, tool: "skill_manage", deletes: "no", opaque: false, digest: DIGEST, args: { action: "delete", name: "plan" } }) }],
    ["an oversized descriptor", { description: pluginMessage({ v: 1, tool: "write_file", deletes: "no", opaque: false, digest: DIGEST, args: { path: "p".repeat(GATE_DESCRIPTOR_MAX_BYTES), size: 1 } }) }],
  ])("%s is unknown", (_label, overrides) => {
    const gate = readGateIdentity(pluginGate("write_file", { deletes: "no", opaque: false, args: { path: "a", size: 1 } }, overrides));
    expect(gate).toEqual({ hermesRequestId: "req-1", hermesExecutionGeneration: null, gateKind: "unknown", toolKey: null, gateArgs: null, descriptorVersion: null });
  });

  test("a terminal gate keeps its pattern and the masked command", () => {
    const gate = readGateIdentity({
      request_id: "req-2", pattern_key: "recursive delete", pattern_keys: ["recursive delete"],
      command: "rm -rf ./build && curl -H 'token: abcdefghijklmnop' example.com", description: "recursive delete",
    });
    expect(gate.gateKind).toBe("terminal_danger");
    expect(gate.gateArgs?.patternKey).toBe("recursive delete");
    expect(gate.gateArgs?.command).toContain("rm -rf ./build");
    expect(gate.gateArgs?.command).not.toContain("abcdefghijklmnop");
  });

  test("a terminal command too long to keep is null, and a list that disagrees is not a terminal gate", () => {
    expect(readGateIdentity({ pattern_key: "recursive delete", command: "x".repeat(2001) }).gateArgs).toEqual({ patternKey: "recursive delete", command: null });
    expect(readGateIdentity({ pattern_key: "recursive delete", pattern_keys: ["recursive delete", "other"] }).gateKind).toBe("unknown");
    expect(readGateIdentity({ pattern_key: "execute_code" }).gateKind).toBe("unknown");
    expect(readGateIdentity({}).gateKind).toBe("unknown");
  });

  test("a request id that is empty or longer than the upstream bound is dropped", () => {
    expect(readGateIdentity({ request_id: "  " }).hermesRequestId).toBeNull();
    expect(readGateIdentity({ request_id: "r".repeat(257) }).hermesRequestId).toBeNull();
    expect(readGateIdentity({ request_id: " req-3 " }).hermesRequestId).toBe("req-3");
  });

  test("the descriptor line never reaches the displayed description", () => {
    const raw = pluginGate("write_file", { deletes: "no", opaque: false, args: { path: "a", size: 1 } });
    expect(gateDescriptionText(raw.description)).toBe("Approve write-capable tool write_file.");
    const [event] = new HermesEventNormalizer().push({ event: "approval.request", run_id: "run", timestamp: 1, choices: ["once", "deny"], ...raw });
    expect(event?.payload.description).toBe("Approve write-capable tool write_file.");
    expect(event?.payload.gate).toMatchObject({ gateKind: "plugin_tool", hermesRequestId: "req-1" });
  });
});
