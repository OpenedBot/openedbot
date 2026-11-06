import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { edgeSetupPath } from "../../../tests/edge-setup-dir";
import {
  ALWAYS_FORBIDDEN_TOOLSETS,
  FORBIDDEN_TOOLSETS,
  APPROVAL_POLICY_WRITE_TOOLS,
  approvalPolicyMode,
  permissionPipelineOf,
  isApprovalPolicyWriteTool,
  PROFILE_RESTRICTED_TOOLSETS,
  runtimeToolsetContractViolation,
  runtimeToolsetIsForbidden,
  runtimeToolsetNameIsContractForbidden,
} from "../src/domain/runtime-contract";
import { RELAY_FEATURE_APPROVAL_POLICY } from "@openedbot/contracts-connector/features";

const memory = { name: "memory", enabled: true, tools: ["memory"] };
const sessionSearch = { name: "session_search", enabled: true, tools: [] };
const cronjob = { name: "cronjob", enabled: true, tools: ["cronjob"] };
const cronjobManage = { name: "cronjob_v022", enabled: true, tools: ["cronjob_manage"] };
const web = { name: "web", enabled: true, tools: ["web_search"] };

// Jumeau de `pins.ForbiddenToolsets` (edge-setup, Go) : les deux tests lisent
// le même manifeste et `make contract-check` compare les deux copies.
const manifest = JSON.parse(
  readFileSync(new URL("./fixtures/forbidden-toolsets.json", import.meta.url), "utf8"),
) as { alwaysForbidden: string[]; profileRestricted: string[] };

describe("runtime toolset contract", () => {
  test("approval policy write class and feature name stay fixed", () => {
    const hostSource = readFileSync(edgeSetupPath("internal/operator/approval_policy.go"), "utf8");
    const hostList = hostSource.match(/approvalPolicyWriteTools = \[\.\.\.\]string\{([^}]+)\}/)?.[1];
    expect(hostList).toBeDefined();
    expect([...APPROVAL_POLICY_WRITE_TOOLS].sort()).toEqual([...((hostList ?? "").matchAll(/"([^"]+)"/g))].map((match) => match[1]!).sort());
    expect(RELAY_FEATURE_APPROVAL_POLICY).toBe("approval_policy");
    expect(["write_file", "patch", "skill_manage", "execute_code", "send_message", "cronjob", "mcp_search"]
      .map(isApprovalPolicyWriteTool)).toEqual([true, true, true, true, true, true, true]);
    expect(["read_file", "terminal", "mcp ", "mcp", "mcpfoo"]
      .map(isApprovalPolicyWriteTool)).toEqual([false, false, false, false, false]);
    const modes = ["manual", "plan", "auto", "bypass"] as const;
    expect(modes.map((mode) => approvalPolicyMode(mode, "legacy"))).toEqual(["ask_writes", "block_writes", "off", "off"]);
    // PERM2-1: under `v2` the pipeline answers every write, so the host must raise them all.
    expect(modes.map((mode) => approvalPolicyMode(mode, "v2"))).toEqual(["ask_writes", "block_writes", "ask_writes", "ask_writes"]);
    expect(["v2", "legacy", "V2", null, undefined, 2].map(permissionPipelineOf)).toEqual(["v2", "legacy", "legacy", "legacy", "legacy", "legacy"]);
  });
  test("ALWAYS_FORBIDDEN_TOOLSETS et PROFILE_RESTRICTED_TOOLSETS suivent le manifeste partagé avec edge-setup", () => {
    expect([...ALWAYS_FORBIDDEN_TOOLSETS].sort()).toEqual([...manifest.alwaysForbidden].sort());
    expect([...PROFILE_RESTRICTED_TOOLSETS].sort()).toEqual([...manifest.profileRestricted].sort());
  });

  test("FORBIDDEN_TOOLSETS reste le jeu runtime pour les appelants non migrés", () => {
    expect([...FORBIDDEN_TOOLSETS].sort()).toEqual([
      "cronjob",
      "delegation",
      "memory",
      "session_search",
    ]);
    expect([...ALWAYS_FORBIDDEN_TOOLSETS].sort()).toEqual(["cronjob", "delegation"]);
    expect([...PROFILE_RESTRICTED_TOOLSETS].sort()).toEqual(["memory", "session_search"]);
  });

  test("memory et session_search violent le contrat sous runtime, pas sous profile", () => {
    expect(runtimeToolsetContractViolation([memory, web])).toEqual({
      code: "HERMES_FORBIDDEN_TOOLSETS_ACTIVE",
      toolsets: ["memory"],
    });
    expect(runtimeToolsetContractViolation([memory, sessionSearch, web], { scope: "runtime" })).toEqual({
      code: "HERMES_FORBIDDEN_TOOLSETS_ACTIVE",
      toolsets: ["memory", "session_search"],
    });
    expect(runtimeToolsetContractViolation([memory, sessionSearch, web], { scope: "profile" })).toBeNull();
    expect(runtimeToolsetIsForbidden(memory, { scope: "profile" })).toBe(false);
    expect(runtimeToolsetNameIsContractForbidden("memory", { scope: "profile" })).toBe(false);
    expect(runtimeToolsetNameIsContractForbidden("memory")).toBe(true);
  });

  test("cronjob et delegation restent une violation sous profile", () => {
    expect(runtimeToolsetContractViolation([cronjob, web], { scope: "profile" })).toEqual({
      code: "HERMES_FORBIDDEN_TOOLSETS_ACTIVE",
      toolsets: ["cronjob"],
    });
    expect(runtimeToolsetNameIsContractForbidden("delegation", { scope: "profile" })).toBe(true);
    expect(runtimeToolsetNameIsContractForbidden("cronjob", { scope: "profile" })).toBe(true);
    expect(runtimeToolsetContractViolation([cronjobManage], { scope: "profile" })).toEqual({
      code: "HERMES_FORBIDDEN_TOOLSETS_ACTIVE",
      toolsets: ["cronjob_v022"],
    });
  });

  test("un inventaire absent reste fail-closed", () => {
    expect(runtimeToolsetContractViolation(null, { scope: "profile" })).toEqual({
      code: "HERMES_TOOLSET_INVENTORY_REQUIRED",
      toolsets: [],
    });
  });
});
