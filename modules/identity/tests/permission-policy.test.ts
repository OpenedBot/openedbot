import { describe, expect, test } from "bun:test";
import type { Db } from "@openedbot/platform-db";
import {
  COMMAND_BLOCKLIST_MAX_ENTRIES,
  COMMAND_BLOCKLIST_MAX_LENGTH,
  normalizeCommandBlocklist,
  permissionModeRaiseRefused,
  permissionModeUnderCeiling,
  type WorkspaceRole,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { canEditPermissionPolicy, readPermissionPolicyInput, savePermissionPolicy } from "../src/application/permission-policy";

describe("normalizeCommandBlocklist", () => {
  test("trims, collapses whitespace and drops exact duplicates in order", () => {
    expect(normalizeCommandBlocklist(["  git   push  --force ", "rm -rf", "git push --force", "npm publish"]))
      .toEqual({ ok: true, entries: ["git push --force", "rm -rf", "npm publish"] });
  });

  test("an empty list is valid", () => {
    expect(normalizeCommandBlocklist([])).toEqual({ ok: true, entries: [] });
  });

  test("keeps case: commands are case-sensitive", () => {
    expect(normalizeCommandBlocklist(["Make deploy", "make deploy"])).toEqual({ ok: true, entries: ["Make deploy", "make deploy"] });
  });

  test("refuses what is not a list of text", () => {
    expect(normalizeCommandBlocklist("rm")).toEqual({ ok: false, issue: "not_text", index: null });
    expect(normalizeCommandBlocklist(["rm", 4])).toEqual({ ok: false, issue: "not_text", index: 1 });
  });

  test("refuses an empty or too long entry, with its index", () => {
    expect(normalizeCommandBlocklist(["rm", "   "])).toEqual({ ok: false, issue: "empty", index: 1 });
    expect(normalizeCommandBlocklist([`echo ${"a".repeat(COMMAND_BLOCKLIST_MAX_LENGTH)}`]))
      .toEqual({ ok: false, issue: "too_long", index: 0 });
    expect(normalizeCommandBlocklist([`e${"a".repeat(COMMAND_BLOCKLIST_MAX_LENGTH - 1)}`]).ok).toBe(true);
  });

  test("refuses shell expressions: quotes, operators, substitutions, globs", () => {
    for (const entry of ["rm 'x'", "rm \"x\"", "rm; ls", "a && b", "a | b", "echo $(id)", "echo `id`", "rm *", "rm x>y", "cat \\x"]) {
      expect(normalizeCommandBlocklist([entry])).toMatchObject({ ok: false, issue: "characters", index: 0 });
    }
  });

  test("the first word is a bare command name", () => {
    for (const entry of ["/usr/bin/rm -rf", "FOO=1 rm", "sudo rm", "command rm"]) {
      expect(normalizeCommandBlocklist([entry])).toMatchObject({ ok: false, issue: "command_name", index: 0 });
    }
    expect(normalizeCommandBlocklist(["kubectl delete ns/prod --context=prod"]).ok).toBe(true);
  });

  test("caps the list at 50 distinct entries", () => {
    const entries = Array.from({ length: COMMAND_BLOCKLIST_MAX_ENTRIES }, (_, index) => `tool${index}`);
    expect(normalizeCommandBlocklist(entries).ok).toBe(true);
    expect(normalizeCommandBlocklist([...entries, "tool0"]).ok).toBe(true);
    expect(normalizeCommandBlocklist([...entries, "one-more"])).toEqual({ ok: false, issue: "too_many", index: null });
  });
});

describe("permissionModeRaiseRefused", () => {
  test("no ceiling refuses nothing", () => {
    for (const mode of ["manual", "plan", "auto", "bypass"] as const) expect(permissionModeRaiseRefused(mode, null, null)).toBe(false);
  });

  test("a raise above the ceiling is refused, on creation and on update", () => {
    expect(permissionModeRaiseRefused("bypass", null, "auto")).toBe(true);
    expect(permissionModeRaiseRefused("auto", null, "manual")).toBe(true);
    expect(permissionModeRaiseRefused("bypass", "manual", "auto")).toBe(true);
    expect(permissionModeRaiseRefused("auto", "plan", "manual")).toBe(true);
  });

  test("plan, modes at or under the ceiling, and lowering are always allowed", () => {
    expect(permissionModeRaiseRefused("plan", "bypass", "manual")).toBe(false);
    expect(permissionModeRaiseRefused("auto", null, "auto")).toBe(false);
    expect(permissionModeRaiseRefused("manual", "bypass", "manual")).toBe(false);
    // A bot already above lowers one step without having to reach the ceiling.
    expect(permissionModeRaiseRefused("auto", "bypass", "manual")).toBe(false);
  });

  test("a new bot is capped at the ceiling when its source asks for more", () => {
    expect(permissionModeUnderCeiling("bypass", "auto")).toBe("auto");
    expect(permissionModeUnderCeiling("auto", "manual")).toBe("manual");
    expect(permissionModeUnderCeiling("plan", "manual")).toBe("plan");
    expect(permissionModeUnderCeiling("bypass", null)).toBe("bypass");
  });
});

describe("readPermissionPolicyInput", () => {
  const valid = { maxMode: "auto", enforceReview: true, rulesMode: "adds", commandBlocklist: [" rm  -rf "], expectedVersion: 0 };

  test("returns the canonical input", () => {
    expect(readPermissionPolicyInput(valid)).toEqual({ ...valid, commandBlocklist: ["rm -rf"] } as never);
    expect(readPermissionPolicyInput({ ...valid, maxMode: null }).maxMode).toBeNull();
  });

  test("refuses each malformed field with a stable code", () => {
    const code = (body: Record<string, unknown>) => {
      try { readPermissionPolicyInput(body); return null; } catch (error) { return error instanceof HttpError ? error.code : "?"; }
    };
    expect(code({ ...valid, maxMode: "plan" })).toBe("PERMISSION_POLICY_INVALID");
    expect(code({ ...valid, enforceReview: "yes" })).toBe("PERMISSION_POLICY_INVALID");
    expect(code({ ...valid, rulesMode: "merge" })).toBe("PERMISSION_POLICY_INVALID");
    expect(code({ ...valid, expectedVersion: -1 })).toBe("PERMISSION_POLICY_INVALID");
    expect(code({ ...valid, expectedVersion: "1" })).toBe("PERMISSION_POLICY_INVALID");
    expect(code({ ...valid, commandBlocklist: ["rm; ls"] })).toBe("PERMISSION_BLOCKLIST_INVALID");
  });
});

describe("role matrix", () => {
  test("owner and admin edit; member does not (D-5)", () => {
    const matrix = Object.fromEntries((["owner", "admin", "member"] as WorkspaceRole[]).map((role) => [role, canEditPermissionPolicy(role)]));
    expect(matrix).toEqual({ owner: true, admin: true, member: false });
  });

  test("a member is refused before any database write", async () => {
    const db = { begin: () => { throw new Error("no write expected"); } } as unknown as Db;
    const input = readPermissionPolicyInput({ maxMode: "manual", enforceReview: false, rulesMode: "adds", commandBlocklist: [], expectedVersion: 0 });
    for (const role of ["member"] as const) {
      const refused = await savePermissionPolicy(db, { organizationId: "org-1", userId: "user-1", role }, input).catch((error) => error);
      expect(refused).toBeInstanceOf(HttpError);
      expect((refused as HttpError).code).toBe("ROLE_REQUIRED");
    }
  });
});
