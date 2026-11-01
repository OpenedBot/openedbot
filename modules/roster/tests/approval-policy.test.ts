import { describe, expect, test } from "bun:test";
import { HermesClientError } from "@openedbot/hermes";
import type { HermesApprovalPolicyMode } from "@openedbot/hermes";
import { applyHostApprovalPolicy, applyTighteningPolicyBeforeMutation, approvalPolicyWriteMustPrecedeCommit } from "../src/application/approval-policy";

describe("applyHostApprovalPolicy", () => {
  test("tightening modes are applied before commit, loosening modes after commit", () => {
    expect(approvalPolicyWriteMustPrecedeCommit("manual")).toBe(true);
    expect(approvalPolicyWriteMustPrecedeCommit("plan")).toBe(true);
    expect(approvalPolicyWriteMustPrecedeCommit("auto")).toBe(false);
    expect(approvalPolicyWriteMustPrecedeCommit("bypass")).toBe(false);
  });

  test("runs validation before host mutation and the host write before the database mutation", async () => {
    const events: string[] = [];
    const validate = async () => { events.push("validate"); };
    await validate();
    await applyTighteningPolicyBeforeMutation("manual", async () => { events.push("host"); }, async () => { events.push("database"); });
    expect(events).toEqual(["validate", "host", "database"]);
    events.length = 0;
    await expect((async () => {
      await Promise.reject(new Error("section missing"));
      await applyTighteningPolicyBeforeMutation("manual", async () => { events.push("host"); }, async () => { events.push("database"); });
    })()).rejects.toThrow("section missing");
    expect(events).toEqual([]);
  });
  test("writes the mapped mode and reads it back before returning proof", async () => {
    const calls: string[] = [];
    let mode: HermesApprovalPolicyMode = "off";
    const state = await applyHostApprovalPolicy(
      { client: {} as never, linkFeatures: ["approval_policy"] },
      "scout",
      "plan",
      "legacy",
      () => ({
        hostSetApprovalPolicy: async (_profile, next) => { calls.push(`write:${next}`); mode = next; return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
        hostApprovalPolicy: async () => { calls.push("read"); return { mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
      }),
    );
    expect(state).toMatchObject({ mode: "block_writes", pluginEnabled: true, effective: true });
    expect(calls).toEqual(["write:block_writes", "read"]);
  });

  test("under v2 an auto bot asks the host to submit its writes", async () => {
    const written: string[] = [];
    const state = await applyHostApprovalPolicy(
      { client: {} as never, linkFeatures: ["approval_policy"] }, "scout", "auto", "v2",
      () => ({
        hostSetApprovalPolicy: async (_profile, next) => { written.push(next); return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
        hostApprovalPolicy: async () => ({ mode: "ask_writes" as const, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      }),
    );
    expect(written).toEqual(["ask_writes"]);
    expect(state?.mode).toBe("ask_writes");
  });

  test("PERM2-2: under v2 a plugin that cannot name its gates is not effective", async () => {
    const client = (gateIdentity: boolean) => () => ({
      hostSetApprovalPolicy: async (_profile: string, next: HermesApprovalPolicyMode) => ({ mode: next, pluginEnabled: true, effective: true, gateIdentity, blockedTools: [] }),
      hostApprovalPolicy: async () => ({ mode: "ask_writes" as const, pluginEnabled: true, effective: true, gateIdentity, blockedTools: [] }),
    });
    const runtime = { client: {} as never, linkFeatures: ["approval_policy"] };
    expect((await applyHostApprovalPolicy(runtime, "scout", "auto", "v2", client(false)))?.effective).toBe(false);
    expect((await applyHostApprovalPolicy(runtime, "scout", "auto", "v2", client(true)))?.effective).toBe(true);
    expect((await applyHostApprovalPolicy(runtime, "scout", "manual", "legacy", client(false)))?.effective).toBe(true);
  });

  test("rejects a mismatched read-back and skips runtimes without the capability", async () => {
    const clientFactory = () => ({
      hostSetApprovalPolicy: async () => ({ mode: "ask_writes" as const, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      hostApprovalPolicy: async () => ({ mode: "off" as const, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
    });
    await expect(applyHostApprovalPolicy(
      { client: {} as never, linkFeatures: ["approval_policy"] }, "scout", "manual", "legacy", clientFactory,
    )).rejects.toBeInstanceOf(HermesClientError);
    await expect(applyHostApprovalPolicy(
      { client: {} as never, linkFeatures: [] }, "scout", "manual", "legacy", () => { throw new Error("must not create client"); },
    )).resolves.toBeNull();
  });
});
