import { afterEach, describe, expect, test } from "bun:test";
import { effectivePermissionModeFor, installApprovalReviewer } from "@openedbot/runtimes/application/approval-reviewer";
import type { Db } from "@openedbot/platform-db";
import { HermesClientError } from "@openedbot/hermes";
import type { HermesApprovalPolicyMode } from "@openedbot/hermes";
import { applyHostApprovalPolicy, applyTighteningPolicyBeforeMutation, approvalPolicyWriteMustPrecedeCommit } from "../src/application/approval-policy";

afterEach(() => installApprovalReviewer(null));

describe("applyHostApprovalPolicy", () => {
  test("tightening modes are applied before commit, loosening modes after commit (the mode is already effective)", () => {
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

  test("the host policy follows the mode resolved per organization: a ready org keeps legacy auto off, an unready one asks", async () => {
    // The plug-in is installed, ready for org B only.
    let tenant = "";
    const tenants: string[] = [];
    installApprovalReviewer({ ready: async (_tx, organizationId) => { tenants.push(tenant); return organizationId === "org-b"; } });
    const tx = (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("");
      if (sql.includes("current_setting('app.organization_id'")) return Promise.resolve([{ previous: tenant }]);
      if (sql.includes("set_config('app.organization_id'")) tenant = String(values[0]);
      return Promise.resolve([]);
    };
    const db = Object.assign(tx, { begin: (run: (inner: unknown) => Promise<unknown>) => run(tx) }) as unknown as Db;
    const host = (written: HermesApprovalPolicyMode[]) => () => ({
      hostSetApprovalPolicy: async (_profile: string, next: HermesApprovalPolicyMode) => { written.push(next); return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
      hostApprovalPolicy: async () => ({ mode: written.at(-1)!, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
    });
    const runtime = { client: {} as never, linkFeatures: ["approval_policy"] };
    const forA: HermesApprovalPolicyMode[] = [];
    const modeA = await effectivePermissionModeFor(db, "org-a", "auto");
    expect(modeA).toBe("manual");
    expect(approvalPolicyWriteMustPrecedeCommit(modeA)).toBe(true);
    await applyHostApprovalPolicy(runtime, "scout", modeA, "legacy", host(forA));
    expect(forA).toEqual(["ask_writes"]);
    const forB: HermesApprovalPolicyMode[] = [];
    const modeB = await effectivePermissionModeFor(db, "org-b", "auto");
    expect(modeB).toBe("auto");
    expect(approvalPolicyWriteMustPrecedeCommit(modeB)).toBe(false);
    await applyHostApprovalPolicy(runtime, "scout", modeB, "legacy", host(forB));
    expect(forB).toEqual(["off"]);
    // Each readiness was read under its own organization's tenant.
    expect(tenants).toEqual(["org-a", "org-b"]);
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
