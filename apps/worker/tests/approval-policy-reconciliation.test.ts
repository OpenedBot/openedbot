import { afterEach, describe, expect, test } from "bun:test";
import { installApprovalReviewer } from "@openedbot/runtimes/application/approval-reviewer";
import type { SQL } from "bun";
import { reconcileHostApprovalPolicies } from "../src/maintenance/approval-policy-reconciliation";
import type { WorkerConfig } from "../src/config";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { HermesClientError, type HermesProfileInventory } from "@openedbot/hermes";
import type { HermesApprovalPolicyMode } from "@openedbot/hermes";
import type { BotPermissionMode } from "@openedbot/contracts-api";
import { createTestLogger, eventFields, runWithLogger } from "@openedbot/platform-observability/log/test-logger";

type ReconciliationCandidate = {
  bot_id: string;
  organization_id: string;
  runtime_id: string;
  profile: string;
  permission_mode: BotPermissionMode;
  permission_pipeline: string;
  approval_policy_mode: string | null;
  approval_policy_effective_at: Date | null;
};

type PolicyState = {
  blockedTools?: string[] | null;
  mode: HermesApprovalPolicyMode;
  pluginEnabled: boolean;
  effective: boolean;
};

const candidate: ReconciliationCandidate = {
  bot_id: "bot-1",
  organization_id: "org-1",
  runtime_id: "runtime-1",
  profile: "scout",
  permission_mode: "manual" as const,
  permission_pipeline: "legacy",
  approval_policy_mode: null,
  approval_policy_effective_at: null,
};

function fakeDb(rows: ReconciliationCandidate[] = [candidate], freshMode: BotPermissionMode = candidate.permission_mode, freshPipeline = "legacy", blocked: string[] = []) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let tenant = "";
  const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...parts].join(" ");
    calls.push({ sql, values });
    if (sql.includes("select b.permission_mode, o.permission_pipeline")) {
      return Promise.resolve([{ permission_mode: freshMode, permission_pipeline: freshPipeline }]);
    }
    if (sql.includes("current_setting('app.organization_id'")) return Promise.resolve([{ previous: tenant }]);
    if (sql.includes("set_config('app.organization_id'")) { tenant = String(values[0]); return Promise.resolve([]); }
    // The tenant-scoped worker policy (0141): no tenant, no row.
    if (sql.includes("from bot_permission_tool_policies")) {
      return Promise.resolve(tenant === values[0] ? blocked.map((toolKey) => ({ toolKey })) : []);
    }
    return Promise.resolve(sql.includes("select b.id") ? rows : []);
  }) as unknown as SQL;
  Object.assign(db, { begin: (run: (tx: SQL) => Promise<unknown>) => run(db) });
  return { db, calls };
}

function inventory(...names: string[]): HermesProfileInventory {
  return { profiles: names.map((name) => ({ name })) } as unknown as HermesProfileInventory;
}

function fakeClientFactory(options: {
  profiles?: string[];
  onInventory?: () => Promise<HermesProfileInventory>;
  onGet?: (profile: string) => Promise<PolicyState>;
  onSet?: (profile: string, mode: HermesApprovalPolicyMode, blockedTools?: readonly string[]) => Promise<PolicyState>;
} = {}): typeof createRuntimeClient {
  return (() => ({
    hostProfileInventory: options.onInventory ?? (async () => inventory(...(options.profiles ?? [candidate.profile]))),
    hostApprovalPolicy: options.onGet ?? (async () => ({ mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] })),
    hostSetApprovalPolicy: options.onSet ?? (async (_profile: string, mode: HermesApprovalPolicyMode) => ({
      mode,
      pluginEnabled: true,
      effective: true,
    })),
  })) as unknown as typeof createRuntimeClient;
}

async function captureInfo(run: (lines: Array<Record<string, unknown>>) => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  const { logger } = createTestLogger({ onRecord: (record) => { lines.push(eventFields(record)); } });
  await runWithLogger(logger, () => run(lines));
  return lines;
}

describe("host approval policy reconciliation", () => {
  afterEach(() => installApprovalReviewer(null));

  test("PERM2-7: a legacy auto bot is hardened to ask_writes where the reviewer is not ready, kept off where it is", async () => {
    const asked: string[] = [];
    // The plug-in is installed, ready for org B only.
    installApprovalReviewer({ ready: async (_tx, organizationId) => { asked.push(organizationId); return organizationId === "org-b"; } });
    const proven = { ...candidate, permission_mode: "auto" as const, approval_policy_mode: "off", approval_policy_effective_at: new Date() };
    const botA = { ...proven, bot_id: "bot-a", organization_id: "org-a", profile: "scout-a" };
    const botB = { ...proven, bot_id: "bot-b", organization_id: "org-b", profile: "scout-b" };
    const { db, calls } = fakeDb([botA, botB], "auto", "legacy");
    const hostModes: Record<string, HermesApprovalPolicyMode> = { "scout-a": "off", "scout-b": "off" };
    const puts: string[] = [];
    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, fakeClientFactory({
      profiles: ["scout-a", "scout-b"],
      onGet: async (profile) => ({ mode: hostModes[profile]!, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      onSet: async (profile, next) => { puts.push(`${profile}:${next}`); hostModes[profile] = next; return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    }), (_org, _bot, run) => run());
    // A is hardened at once, though its `off` proof was fresh; B keeps `off` and is not even read.
    expect(puts).toEqual(["scout-a:ask_writes"]);
    expect(hostModes).toEqual({ "scout-a": "ask_writes", "scout-b": "off" });
    const proofs = calls.filter((call) => call.sql.includes("set approval_policy_mode"));
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.values).toEqual(expect.arrayContaining(["ask_writes", true, "org-a", "bot-a"]));
    // Readiness is asked per organization, in a transaction scoped to it.
    expect(new Set(asked)).toEqual(new Set(["org-a", "org-b"]));
    const tenants = calls.filter((call) => call.sql.includes("set_config('app.organization_id'")).map((call) => call.values[0]);
    expect(new Set(tenants)).toEqual(new Set(["org-a", "org-b"]));
  });

  test("PERM2-7: the pass only hardens; once the reviewer is ready a hardened profile stays ask_writes, repaired as such", async () => {
    installApprovalReviewer({ ready: async () => true });
    const hardened = { ...candidate, permission_mode: "auto" as const, approval_policy_mode: "ask_writes", approval_policy_effective_at: new Date(0) };
    const kept = fakeDb([hardened], "auto", "legacy");
    const puts: string[] = [];
    await reconcileHostApprovalPolicies(kept.db, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => ({ mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      onSet: async (_profile, next) => { puts.push(next); return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    }), (_org, _bot, run) => run());
    // Re-proven as it stands: no lift back to `off` from the reconciliation.
    expect(puts).toEqual([]);
    expect(kept.calls.at(-1)?.values).toEqual(expect.arrayContaining(["ask_writes", true]));

    // A hardened profile whose policy file is gone is repaired hardened too.
    const lost = fakeDb([{ ...hardened, bot_id: "bot-lost" }], "auto", "legacy");
    let reads = 0;
    await reconcileHostApprovalPolicies(lost.db, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => {
        if (reads++ === 0) throw new Error("policy file missing");
        return { mode: "ask_writes" as const, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] };
      },
      onSet: async (_profile, next) => { puts.push(next); return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    }), (_org, _bot, run) => run());
    expect(puts).toEqual(["ask_writes"]);
  });

  test("applies and reads back a missing mode before storing the effective proof", async () => {
    const { db, calls } = fakeDb();
    const hostCalls: string[] = [];
    let mode: HermesApprovalPolicyMode = "off";
    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, fakeClientFactory({
      onInventory: async () => { hostCalls.push("inventory"); return inventory("scout"); },
      onGet: async () => { hostCalls.push("get"); return { mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
      onSet: async (_profile, next) => { hostCalls.push(`put:${next}`); mode = next; return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    }), (_org, _bot, run) => run());
    expect(hostCalls).toEqual(["inventory", "get", "put:ask_writes", "get"]);
    expect(calls.at(-1)?.values).toContain("ask_writes");
    expect(calls.at(-1)?.values).toContain(true);
  });

  test("does not store effective proof while the host awaits a gateway restart", async () => {
    const { db, calls } = fakeDb();
    let writes = 0;
    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => ({ mode: "ask_writes", pluginEnabled: true, effective: false, gateIdentity: true, blockedTools: [] }),
      onSet: async () => { writes += 1; return { mode: "ask_writes", pluginEnabled: true, effective: false, gateIdentity: true, blockedTools: [] }; },
    }), (_org, _bot, run) => run());
    expect(writes).toBe(0);
    expect(calls.at(-1)?.values).toContain(false);
  });

  test("repairs a legacy profile whose policy GET has no readable policy file", async () => {
    const { db } = fakeDb();
    const hostCalls: string[] = [];
    let reads = 0;
    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => {
        hostCalls.push("get");
        if (reads++ === 0) throw new Error("policy file missing");
        return { mode: "ask_writes" as const, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] };
      },
      onSet: async (_profile, mode) => {
        hostCalls.push(`put:${mode}`);
        return { mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] };
      },
    }), (_org, _bot, run) => run());
    expect(hostCalls).toEqual(["get", "put:ask_writes", "get"]);
  });

  test("an auto bot proven off is rewritten to ask_writes once its organization is in v2", async () => {
    const proven = { ...candidate, permission_mode: "auto" as const, approval_policy_mode: "off", approval_policy_effective_at: new Date() };
    const { db } = fakeDb([{ ...proven, permission_pipeline: "v2" }], "auto", "v2");
    const puts: string[] = [];
    let hostMode: HermesApprovalPolicyMode = "off";
    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => ({ mode: hostMode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      onSet: async (_profile, next) => { puts.push(next); hostMode = next; return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    }), (_org, _bot, run) => run());
    expect(puts).toEqual(["ask_writes"]);
    // The same bot in a legacy organization is already proven: nothing is written.
    const legacy = fakeDb([proven], "auto", "legacy");
    const legacyPuts: string[] = [];
    await reconcileHostApprovalPolicies(legacy.db, {} as WorkerConfig, undefined, fakeClientFactory({
      onSet: async (_profile, next) => { legacyPuts.push(next); return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    }), (_org, _bot, run) => run());
    expect(legacyPuts).toEqual([]);
  });

  test("applies the mode read under the profile lock, not the stale batch snapshot", async () => {
    const { db } = fakeDb([candidate], "manual");
    const puts: string[] = [];
    const locked: string[] = [];
    const stale = { ...candidate, permission_mode: "auto" as const };
    const staleDb = ((parts: TemplateStringsArray, ...values: unknown[]) =>
      [...parts].join(" ").includes("select b.id") ? Promise.resolve([stale]) : (db as unknown as (p: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(parts, ...values)) as unknown as SQL;
    Object.assign(staleDb, { begin: (run: (tx: SQL) => Promise<unknown>) => run(db) });
    let hostMode: HermesApprovalPolicyMode = "off";
    await reconcileHostApprovalPolicies(staleDb, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => ({ mode: hostMode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      onSet: async (_profile, next) => { puts.push(next); hostMode = next; return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    }), (org, bot, run) => { locked.push(`${org}:${bot}`); return run(); });
    expect(locked).toEqual(["org-1:bot-1"]);
    expect(puts).toEqual(["ask_writes"]);
  });

  test("does not re-read a proven policy before ten minutes", async () => {
    const startedAt = 1_800_000_000_000;
    const proven = {
      ...candidate,
      bot_id: "bot-proven",
      approval_policy_mode: "ask_writes",
      approval_policy_effective_at: new Date(startedAt),
    };
    const { db } = fakeDb([proven]);
    let inventoryReads = 0;
    let policyReads = 0;
    let nowMs = startedAt;
    const clientFactory = fakeClientFactory({
      onInventory: async () => { inventoryReads += 1; return inventory("scout"); },
      onGet: async () => { policyReads += 1; return { mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    });

    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
    nowMs += 10 * 60_000 - 1;
    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
    expect(inventoryReads).toBe(0);
    expect(policyReads).toBe(0);

    nowMs += 1;
    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
    expect(inventoryReads).toBe(1);
    expect(policyReads).toBe(1);
  });

  test("skips missing profiles without writes and retries once per backoff window", async () => {
    const first = { ...candidate, bot_id: "bot-missing-a", profile: "old-profile-a" };
    const second = { ...candidate, bot_id: "bot-missing-b", profile: "old-profile-b" };
    const { db, calls } = fakeDb([first, second]);
    let nowMs = 1_800_000_000_000;
    let inventoryReads = 0;
    let policyReads = 0;
    const clientFactory = fakeClientFactory({
      onInventory: async () => { inventoryReads += 1; return inventory("another-profile"); },
      onGet: async () => { policyReads += 1; return { mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    });

    const logs = await captureInfo(async (lines) => {
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => line.event)).toEqual([
        "worker.approval_policy_profile_missing",
        "worker.approval_policy_profile_missing",
      ]);
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      expect(lines).toHaveLength(2);
      nowMs += 29_999;
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      expect(lines).toHaveLength(2);
      nowMs += 1;
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      expect(lines).toHaveLength(4);
    });

    expect(logs[0]).toMatchObject({ botId: first.bot_id, organizationId: first.organization_id, profile: first.profile });
    expect(logs[1]).toMatchObject({ botId: second.bot_id, organizationId: second.organization_id, profile: second.profile });
    expect(inventoryReads).toBe(2);
    expect(policyReads).toBe(0);
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes("select b.permission_mode, o.permission_pipeline"))).toBe(false);
  });

  test("backs off exponentially and logs only the Hermes error code and status", async () => {
    const failingBot = { ...candidate, bot_id: "bot-exponential" };
    const { db, calls } = fakeDb([failingBot]);
    let nowMs = 1_800_000_000_000;
    let inventoryReads = 0;
    const clientFactory = fakeClientFactory({
      onInventory: async () => { inventoryReads += 1; return inventory("scout"); },
      onGet: async () => ({ mode: "off", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      onSet: async () => { throw new HermesClientError("host-specific private text", 502, "APPROVAL_POLICY_UNVERIFIED"); },
    });

    const logs = await captureInfo(async (lines) => {
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      nowMs += 29_999;
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      expect(lines).toHaveLength(1);
      nowMs += 1;
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      nowMs = 1_800_000_089_999;
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      expect(lines).toHaveLength(2);
      nowMs += 1;
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
    });

    expect(logs.map((line) => line.attempt)).toEqual([1, 2, 3]);
    expect(logs).toEqual(logs.map((line) => ({
      event: "worker.approval_policy_reconcile_failed",
      botId: failingBot.bot_id,
      organizationId: failingBot.organization_id,
      code: "APPROVAL_POLICY_UNVERIFIED",
      status: 502,
      attempt: line.attempt,
    })));
    expect(JSON.stringify(logs)).not.toContain("host-specific private text");
    expect(inventoryReads).toBe(3);
    expect(calls.filter(({ sql }) => sql.includes("update bots")).length).toBe(3);
  });

  test("clears a bot's backoff after successful reconciliation", async () => {
    const retryingBot = { ...candidate, bot_id: "bot-backoff-reset" };
    const { db } = fakeDb([retryingBot]);
    let nowMs = 1_800_000_000_000;
    let failWrite = true;
    let hostMode: HermesApprovalPolicyMode = "off";
    const clientFactory = fakeClientFactory({
      onGet: async () => ({ mode: hostMode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      onSet: async (_profile, mode) => {
        if (failWrite) throw new HermesClientError("private host text", 502, "APPROVAL_POLICY_UNVERIFIED");
        hostMode = mode;
        return { mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] };
      },
    });

    const logs = await captureInfo(async () => {
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      nowMs += 30_000;
      failWrite = false;
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
      failWrite = true;
      hostMode = "off";
      nowMs += 1;
      await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run(), () => nowMs);
    });

    expect(logs.map((line) => line.attempt)).toEqual([1, 1]);
  });
  test("PERM2-A: a v2 profile with the older plugin is rewritten, then proven once the gateway loaded it", async () => {
    const older = fakeDb([candidate], "manual", "v2");
    let gateIdentity = false;
    let restartPending = false;
    let writes = 0;
    const clientFactory = fakeClientFactory({
      onGet: async () => ({ mode: "ask_writes", pluginEnabled: true, effective: !restartPending, gateIdentity, blockedTools: [] }),
      onSet: async (_profile, next) => {
        writes += 1;
        gateIdentity = true;
        restartPending = true;
        return { mode: next, pluginEnabled: true, effective: false, gateIdentity, blockedTools: [] };
      },
    });
    await reconcileHostApprovalPolicies(older.db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run());
    expect(writes).toBe(1);
    expect(older.calls.at(-1)?.values).toContain(false);

    // The owner restarted the gateway: the next pass proves it without writing.
    restartPending = false;
    const after = fakeDb([candidate], "manual", "v2");
    await reconcileHostApprovalPolicies(after.db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run());
    expect(writes).toBe(1);
    expect(after.calls.at(-1)?.values).toContain(true);

    // A legacy organization never needs the identified plugin.
    gateIdentity = false;
    const legacy = fakeDb([candidate], "manual", "legacy");
    await reconcileHostApprovalPolicies(legacy.db, {} as WorkerConfig, undefined, clientFactory, (_org, _bot, run) => run());
    expect(writes).toBe(1);
  });

  test("PERM2-5: a host whose blocked list differs from the stored keys is rewritten with them, sorted", async () => {
    const { db, calls } = fakeDb([candidate], "manual", "v2", ["write_file", "mcp:files:delete"]);
    let held: string[] = [];
    const sets: Array<readonly string[] | undefined> = [];
    await reconcileHostApprovalPolicies(db, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => ({ mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: held }),
      onSet: async (_profile, next, blockedTools) => {
        sets.push(blockedTools);
        if (blockedTools) held = [...blockedTools];
        return { mode: next, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: held };
      },
    }), (_org, _bot, run) => run());
    expect(sets).toEqual([["mcp:files:delete", "write_file"]]);
    expect(calls.at(-1)?.values).toContain(true);
  });

  test("PERM2-5: a matching blocked list needs no write; a host that cannot hold it is not effective", async () => {
    const matching = fakeDb([candidate], "manual", "v2", ["patch"]);
    let writes = 0;
    await reconcileHostApprovalPolicies(matching.db, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => ({ mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: ["patch"] }),
      onSet: async () => { writes += 1; return { mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: ["patch"] }; },
    }), (_org, _bot, run) => run());
    expect(writes).toBe(0);
    expect(matching.calls.at(-1)?.values).toContain(true);

    const lossy = fakeDb([{ ...candidate, bot_id: "bot-lossy" }], "manual", "v2", ["patch"]);
    await reconcileHostApprovalPolicies(lossy.db, {} as WorkerConfig, undefined, fakeClientFactory({
      onGet: async () => ({ mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
      // A fake that claims the write but keeps nothing: the re-read decides.
      onSet: async () => ({ mode: "ask_writes", pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }),
    }), (_org, _bot, run) => run());
    const proof = lossy.calls.at(-1);
    expect(proof?.sql).toContain("approval_policy_effective_at");
    expect(proof?.values).toContain(false);
    expect(proof?.values).not.toContain(true);
  });
});
