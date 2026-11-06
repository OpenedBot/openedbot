import { describe, expect, test } from "bun:test";
import { PERMISSION_RULE_MAX_CHARS } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { normalizePermissionRuleText, readPermissionRuleInput } from "../src/domain/permission-rule-input";

function code(run: () => unknown): string | null {
  try { run(); return null; } catch (error) { return error instanceof HttpError ? error.code : "UNEXPECTED"; }
}

describe("PERM2-6 permission rule input", () => {
  test("a rule is stored on one line, whitespace collapsed", () => {
    expect(normalizePermissionRuleText("  Edit files\n\tin   docs  ")).toBe("Edit files in docs");
    expect(readPermissionRuleInput({ kind: "ask_first", text: "Sending\r\nemail" })).toEqual({ kind: "ask_first", text: "Sending email" });
  });

  test("secrets are masked before the rule is stored", () => {
    const text = normalizePermissionRuleText("Push with token=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB only");
    expect(text).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB");
    expect(text).toContain("[redacted]");
  });

  test("control characters never reach the database check", () => {
    expect(normalizePermissionRuleText("Edit\u0000 docs\u001b[31m")).toBe("Edit docs");
  });

  test("empty, too long or not text is refused", () => {
    for (const body of [
      { kind: "allow", text: "   " },
      { kind: "allow", text: "x".repeat(PERMISSION_RULE_MAX_CHARS + 1) },
      { kind: "allow", text: "x".repeat(PERMISSION_RULE_MAX_CHARS * 4 + 1) },
      { kind: "allow", text: 42 },
      { kind: "allow" },
    ]) expect(code(() => readPermissionRuleInput(body))).toBe("PERMISSION_RULE_INVALID");
    expect(readPermissionRuleInput({ kind: "allow", text: "x".repeat(PERMISSION_RULE_MAX_CHARS) }).text).toHaveLength(PERMISSION_RULE_MAX_CHARS);
  });

  test("only the two kinds are accepted", () => {
    for (const kind of ["deny", "ALLOW", "", null, undefined]) {
      expect(code(() => readPermissionRuleInput({ kind, text: "Edit docs" }))).toBe("PERMISSION_RULE_INVALID");
    }
  });
});
