import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HermesApprovalPolicyMode } from "@openedbot/hermes";
import { BOT_TOOL_POLICY_KEY, BOT_TOOL_POLICY_MAX_BLOCKED } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { applyHostApprovalPolicy, blockedToolsForHost } from "../src/application/approval-policy";
import { readToolPolicyWrites } from "../src/domain/tool-policy-input";
import { edgeSetupPath } from "../../../tests/edge-setup-dir";

describe("PERM2-5: the blocked list proof", () => {
  type State = { mode: HermesApprovalPolicyMode; pluginEnabled: boolean; effective: boolean; gateIdentity: boolean; blockedTools: string[] | null };
  const runtime = { client: {} as never, linkFeatures: ["approval_policy"] };
  /** A host that keeps the list it is sent, unless `keeps` is false; `null` is a host older than PERM2-A. */
  function host(initial: string[] | null, keeps = true) {
    let held = initial;
    let mode: HermesApprovalPolicyMode = "ask_writes";
    const writes: Array<readonly string[] | undefined> = [];
    const state = (): State => ({ mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: held });
    return {
      writes,
      factory: () => ({
        hostSetApprovalPolicy: async (_profile: string, next: HermesApprovalPolicyMode, blockedTools?: readonly string[]) => {
          writes.push(blockedTools);
          mode = next;
          if (blockedTools && keeps && held !== null) held = [...blockedTools];
          return state();
        },
        hostApprovalPolicy: async () => state(),
      }),
    };
  }

  test("the stored keys are written in byte order and the proof requires the re-read list to equal them", async () => {
    const h = host([]);
    const state = await applyHostApprovalPolicy(runtime, "scout", "auto", "v2", h.factory, ["write_file", "mcp:files:delete"]);
    expect(h.writes).toEqual([["mcp:files:delete", "write_file"]]);
    expect(state).toMatchObject({ effective: true, blockedTools: ["mcp:files:delete", "write_file"] });
    expect(blockedToolsForHost(["patch", "Patch", "patch"])).toEqual(["Patch", "patch"]);
  });

  test("a re-read list that differs makes the host policy not effective", async () => {
    expect((await applyHostApprovalPolicy(runtime, "scout", "manual", "v2", host([], false).factory, ["patch"]))?.effective).toBe(false);
  });

  test("a host older than PERM2-A is effective only while nothing is blocked, and is never sent an empty list", async () => {
    const empty = host(null);
    expect((await applyHostApprovalPolicy(runtime, "scout", "manual", "legacy", empty.factory, []))?.effective).toBe(true);
    expect(empty.writes).toEqual([undefined]);
    expect((await applyHostApprovalPolicy(runtime, "scout", "manual", "legacy", host(null).factory, ["patch"]))?.effective).toBe(false);
  });

  test("an empty stored list clears a list the host still holds", async () => {
    const h = host(["patch"]);
    const state = await applyHostApprovalPolicy(runtime, "scout", "manual", "v2", h.factory, []);
    expect(h.writes).toEqual([undefined, []]);
    expect(state).toMatchObject({ effective: true, blockedTools: [] });
  });

  test("without a list the host keeps its own and the proof does not look at it", async () => {
    const h = host(["patch"]);
    expect((await applyHostApprovalPolicy(runtime, "scout", "manual", "v2", h.factory))?.effective).toBe(true);
    expect(h.writes).toEqual([undefined]);
  });

  test("the contract key grammar and bound are the client's, the host's and the migration's", () => {
    const root = join(import.meta.dir, "../../..");
    const read = (path: string) => readFileSync(join(root, path), "utf8");
    const client = read("platform/hermes/src/parsers/profiles.ts");
    expect(client).toContain(`export const APPROVAL_POLICY_TOOL_KEY = /${BOT_TOOL_POLICY_KEY.source}/;`);
    expect(client).toContain(`export const APPROVAL_POLICY_MAX_BLOCKED_TOOLS = ${BOT_TOOL_POLICY_MAX_BLOCKED};`);
    const go = readFileSync(edgeSetupPath("internal/operator/approval_policy.go"), "utf8");
    expect(go).toContain(`regexp.MustCompile(\`${BOT_TOOL_POLICY_KEY.source}\`)`);
    expect(go).toContain(`const approvalPolicyMaxBlockedTools = ${BOT_TOOL_POLICY_MAX_BLOCKED}`);
    expect(read("db/migrations/0141_permission_tool_policies.sql")).toContain(`check (tool_key ~ '${BOT_TOOL_POLICY_KEY.source}')`);
  });
});

describe("readToolPolicyWrites", () => {
  const refused = (body: Record<string, unknown>): string => {
    try {
      readToolPolicyWrites(body);
    } catch (error) {
      if (error instanceof HttpError) return `${error.status}:${error.code}`;
      throw error;
    }
    return "accepted";
  };

  test("accepts gated native tools and MCP tools, with the four values", () => {
    expect(readToolPolicyWrites({ policies: [
      { toolKey: "write_file", policy: "block" },
      { toolKey: "mcp:files:delete_file", policy: "block" },
      { toolKey: "execute_code", policy: "ask" },
      { toolKey: "patch", policy: "always" },
    ] })).toHaveLength(4);
  });

  test("refuses always on an opaque operation, execute_code and any MCP tool, and keeps the other values", () => {
    expect(refused({ policies: [{ toolKey: "execute_code", policy: "always" }] })).toBe("400:TOOL_POLICY_ALWAYS_OPAQUE");
    expect(refused({ policies: [{ toolKey: "mcp:files:read_file", policy: "always" }] })).toBe("400:TOOL_POLICY_ALWAYS_OPAQUE");
    expect(refused({ policies: [{ toolKey: "mcp:files:read_file", policy: "inherit" }] })).toBe("accepted");
    expect(refused({ policies: [{ toolKey: "execute_code", policy: "block" }] })).toBe("accepted");
    expect(refused({ policies: [{ toolKey: "send_message", policy: "always" }] })).toBe("accepted");
  });

  test("refuses an empty, oversized or malformed list", () => {
    expect(refused({})).toBe("400:TOOL_POLICIES_INVALID");
    expect(refused({ policies: [] })).toBe("400:TOOL_POLICIES_INVALID");
    expect(refused({ policies: "write_file" })).toBe("400:TOOL_POLICIES_INVALID");
    const many = Array.from({ length: 65 }, (_, index) => ({ toolKey: `mcp:s:t${index}`, policy: "block" }));
    expect(refused({ policies: many })).toBe("400:TOOL_POLICIES_INVALID");
    expect(refused({ policies: [{ toolKey: "patch", policy: "ask" }, { toolKey: "patch", policy: "block" }] })).toBe("400:TOOL_POLICIES_INVALID");
  });

  test("refuses keys outside the grammar or outside the gated families", () => {
    for (const toolKey of ["rm -rf", "Write_file", "mcp:files", "mcp:fi/les:x", "read_file", "terminal", "cronjob", "", 42]) {
      expect(refused({ policies: [{ toolKey, policy: "block" }] })).toBe("400:TOOL_POLICY_KEY_INVALID");
    }
  });

  test("refuses an unknown value", () => {
    for (const policy of ["deny", "ALWAYS", null, 1]) {
      expect(refused({ policies: [{ toolKey: "patch", policy }] })).toBe("400:TOOL_POLICY_INVALID");
    }
  });
});
