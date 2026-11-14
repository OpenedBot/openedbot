import { describe, expect, test } from "bun:test";
import { alwaysChoiceFor, isAlwaysChoice } from "../src/domain/permission-always";
import type { PermissionGate } from "../src/domain/permission-decision";

const WRITE: PermissionGate = {
  kind: "plugin_tool",
  toolKey: "write_file",
  descriptor: { tool: "write_file", deletes: "no", opaque: false, digest: "a".repeat(64), args: { path: "notes.md", size: 4 } },
  command: null,
  choices: ["once", "deny"],
};
const TERMINAL: PermissionGate = { kind: "terminal_danger", toolKey: null, descriptor: null, command: "git push --force", choices: ["once", "deny"] };

describe("alwaysChoiceFor", () => {
  test("a grantable plugin gate offers the bot grant, a terminal gate the runtime switch", () => {
    expect(alwaysChoiceFor(WRITE, "auto")).toBe("always_bot_tool");
    expect(alwaysChoiceFor(TERMINAL, "bypass")).toBe("always_runtime_terminal");
  });

  test("never an Always the pre-approval would not cover", () => {
    const cases: PermissionGate[] = [
      { ...WRITE, descriptor: { ...WRITE.descriptor!, deletes: "yes" } },
      { ...WRITE, descriptor: { ...WRITE.descriptor!, deletes: "unknown" } },
      { ...WRITE, descriptor: { ...WRITE.descriptor!, opaque: true } },
      { ...WRITE, descriptor: { ...WRITE.descriptor!, args: { path: "/home/camille/.ssh/id_rsa", size: 1 } } },
      { ...WRITE, toolKey: "cronjob", descriptor: { ...WRITE.descriptor!, tool: "cronjob", args: {} } },
      { ...WRITE, descriptor: null },
      { ...WRITE, choices: ["deny"] },
      { ...WRITE, kind: "unknown", toolKey: null, descriptor: null },
      // MCP: the host cannot prove `deletes = no`.
      { ...WRITE, toolKey: "mcp:files:write", descriptor: { ...WRITE.descriptor!, tool: "mcp:files:write", deletes: "unknown", args: { server: "files", tool: "write", arguments: {} } } },
      { ...TERMINAL, command: "rm -rf build" },
      { ...TERMINAL, command: null },
      { ...TERMINAL, command: "rm -rf /" },
    ];
    for (const gate of cases) expect(alwaysChoiceFor(gate, "auto")).toBeNull();
  });

  // Lab, 2026-10-25: "Always" clicked on a manual bot's card changed nothing,
  // the next gate asked again. The pipeline reads a grant in auto and bypass only.
  test("no Always under a mode that never reads it, nor without a known mode", () => {
    for (const mode of ["manual", "plan", null, "legacy"]) {
      expect(alwaysChoiceFor(WRITE, mode)).toBeNull();
      expect(alwaysChoiceFor(TERMINAL, mode)).toBeNull();
    }
  });

  test("the extended choices are a closed set", () => {
    expect(isAlwaysChoice("always_bot_tool")).toBe(true);
    expect(isAlwaysChoice("always_runtime_terminal")).toBe(true);
    for (const value of ["always", "session", "once", "", null, 1]) expect(isAlwaysChoice(value)).toBe(false);
  });
});
