import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { provisionCapabilityBaseline, reconcileCapabilityBaselines } from "../src/maintenance/capability-baseline-reconciliation";
import { createTestLogger, eventFields, runWithLogger } from "@openedbot/platform-observability/log/test-logger";
import type { WorkerConfig } from "../src/config";
import { createRuntimeClient } from "@openedbot/execution/application/runtime-client";
import { HermesClientError, type HermesProfileInventory } from "@openedbot/hermes";
import type { BotPermissionMode } from "@openedbot/contracts-api";
import { DEFAULT_BOT_TOOLSETS } from "@openedbot/runtimes/domain/runtime-contract";
import { BASELINE_GATE_PROOF_MAX_AGE_MS, CAPABILITY_BASELINE_VERSION } from "@openedbot/roster/domain/capability-baseline";

type HermesProfileIsolation = Awaited<ReturnType<ReturnType<typeof createRuntimeClient>["probeProfileIsolation"]>>;

type Candidate = {
  bot_id: string;
  organization_id: string;
  runtime_id: string;
  profile: string;
  host_holds_policy: boolean;
};

const candidate: Candidate = {
  bot_id: "bot-1",
  organization_id: "org-1",
  runtime_id: "runtime-1",
  profile: "scout",
  host_holds_policy: true,
};

/** The bot row re-read under the lock: version, permission mode and its gate proof. */
type FreshRow = {
  capability_baseline_version: number;
  permission_mode: BotPermissionMode;
  permission_pipeline: string;
  approval_policy_mode: string | null;
  approval_policy_effective_at: Date | null;
};

const heavyToolsets = [
  { name: "web", enabled: false },
  { name: "terminal", enabled: true },
  { name: "skills", enabled: false },
  { name: "file", enabled: true },
  { name: "code_execution", enabled: true },
  { name: "vision", enabled: false },
];

/**
 * By default the bot is gated: a `manual` bot whose host policy was proven in
 * `ask_writes` a minute before `clock()`. `fresh` is read at each query, so a
 * test can change the proof between passes; `null` is a bot deleted meanwhile.
 */
function fakeDb(rows: Candidate[] = [candidate], fresh: Partial<FreshRow> | null = {}, clock: () => number = Date.now) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...parts].join(" ");
    calls.push({ sql, values });
    if (sql.includes("select b.capability_baseline_version")) {
      if (fresh === null) return Promise.resolve([]);
      const row: FreshRow = {
        capability_baseline_version: 0,
        permission_mode: "manual",
        permission_pipeline: "legacy",
        approval_policy_mode: "ask_writes",
        approval_policy_effective_at: new Date(clock() - 60_000),
        ...fresh,
      };
      return Promise.resolve([row]);
    }
    return Promise.resolve(sql.includes("select b.id") ? rows : []);
  }) as unknown as SQL;
  return { db, calls };
}

function inventory(profile: string, toolsets = heavyToolsets): HermesProfileInventory {
  return { profiles: [{ name: profile, toolsets }] } as unknown as HermesProfileInventory;
}

type BundledState = { profile: string; requested: boolean; bundled: number; bundledEnabled: number; applied: boolean };

function fakeClientFactory(options: {
  toolsets?: typeof heavyToolsets;
  onInventory?: () => Promise<HermesProfileInventory>;
  onToolset?: (profile: string, name: string, enabled: boolean) => Promise<{ enabled: boolean }>;
  onToolsets?: (profile: string, toolsets: Record<string, boolean>) => Promise<Array<{ name: string; enabled: boolean }>>;
  /** Records one entry per batch write the default host takes. */
  batches?: Array<Record<string, boolean>>;
  onBundled?: (profile: string, enabled: boolean) => Promise<BundledState>;
  onSettable?: () => Promise<{ platform: string; settable: string[] }>;
  onIsolation?: (profile: string) => Promise<HermesProfileIsolation>;
  /** Records `name:enabled` for each write the default (stateful) host takes. */
  written?: string[];
} = {}): typeof createRuntimeClient {
  // The default host keeps state: a toolset write shows in the next inventory
  // read, as on a real host, so the post-write verification can pass.
  const state = new Map((options.toolsets ?? heavyToolsets).map((toolset) => [toolset.name, toolset.enabled] as const));
  const current = () => [...state].map(([name, enabled]) => ({ name, enabled }));
  const readInventory = options.onInventory ?? (async () => inventory(candidate.profile, current()));
  return ((target: { hermesProfile: string | null }) => ({
    hostToolsets: options.onSettable ?? (async () => ({ platform: "api_server", settable: [...state.keys(), "web", "terminal", "skills"], availability: null })),
    hostProfileInventory: readInventory,
    // The profile client's gateway view (`/p/<slug>/v1/toolsets`), from the
    // same host state: `null` when the gateway does not serve the profile.
    toolsets: async () => (await readInventory()).profiles.find((row) => row.name === target.hermesProfile)?.toolsets ?? null,
    hostSetProfileToolset: options.onToolset ?? (async (_profile: string, name: string, enabled: boolean) => {
      options.written?.push(`${name}:${enabled}`);
      state.set(name, enabled);
      return { enabled };
    }),
    hostSetProfileToolsets: options.onToolsets ?? (async (_profile: string, toolsets: Record<string, boolean>) => {
      options.batches?.push(toolsets);
      for (const [name, enabled] of Object.entries(toolsets)) state.set(name, enabled);
      return Object.keys(toolsets).sort().map((name) => ({ name, enabled: state.get(name)! }));
    }),
    hostSetProfileBundledSkills: options.onBundled ?? (async (profile: string, enabled: boolean) => ({
      profile, requested: enabled, bundled: 74, bundledEnabled: 0, applied: true,
    })),
    probeProfileIsolation: options.onIsolation ?? (async () => "isolated" as const),
  })) as unknown as typeof createRuntimeClient;
}

const runLocked = <T>(_org: string, _bot: string, run: () => Promise<T>) => run();

async function captureInfo(run: (lines: Array<Record<string, unknown>>) => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  const { logger } = createTestLogger({ onRecord: (record) => { lines.push(eventFields(record)); } });
  await runWithLogger(logger, () => run(lines));
  return lines;
}

describe("capability baseline reconciliation", () => {
  test("never writes a toolset the host cannot set, and still stamps the baseline (bfl, lab 2026-10-23)", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-bfl" }]);
    const written: string[] = [];
    await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        onToolset: async (_p, name, enabled) => { written.push(name); return { enabled }; },
        toolsets: [
          { name: "bfl", enabled: true },
          { name: "web", enabled: true },
          { name: "terminal", enabled: true },
          { name: "skills", enabled: true },
          { name: "todo", enabled: true },
        ],
        onSettable: async () => ({ platform: "api_server", settable: ["web", "terminal", "skills", "todo"] }),
      }), runLocked);
    });
    expect(written).not.toContain("bfl");
    expect(calls.at(-1)?.sql).toContain("update bots set capability_baseline_version");
  });

  test("behind a proven gate, applies the default toolsets, then the bundled skills, then stamps the version", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-apply" }]);
    const hostCalls: string[] = [];
    const host = new Map(heavyToolsets.map((toolset) => [toolset.name, toolset.enabled] as const));
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        onInventory: async () => {
          hostCalls.push("inventory");
          return inventory("scout", [...host].map(([name, enabled]) => ({ name, enabled })));
        },
        onToolset: async (profile, name, enabled) => {
          hostCalls.push(`toolset:${profile}:${name}:${enabled}`);
          host.set(name, enabled);
          return { enabled };
        },
        onBundled: async (profile, enabled) => {
          hostCalls.push(`bundled:${profile}:${enabled}`);
          return { profile, requested: enabled, bundled: 74, bundledEnabled: 0, applied: true };
        },
        onIsolation: async (profile) => { hostCalls.push(`isolation:${profile}`); return "isolated"; },
      }), runLocked);
    });
    // The isolation is probed before the writes and again before the stamp.
    expect(hostCalls).toEqual([
      "inventory",
      "isolation:scout",
      "inventory",
      "toolset:scout:web:true",
      "toolset:scout:vision:true",
      "toolset:scout:skills:true",
      "bundled:scout:false",
      "inventory",
      "isolation:scout",
    ]);
    const stamp = calls.at(-1)!;
    expect(stamp.sql).toContain("update bots set capability_baseline_version");
    expect(stamp.values).toEqual([CAPABILITY_BASELINE_VERSION, "org-1", "bot-apply"]);
    expect(logs).toEqual([{
      event: "worker.capability_baseline_applied",
      botId: "bot-apply",
      organizationId: "org-1",
      profile: "scout",
      gate: "gated",
      isolated: true,
      toolsetWrites: [
        { name: "web", enabled: true },
        { name: "vision", enabled: true },
        { name: "skills", enabled: true },
      ],
      // Wanted but not settable on this host: named, not dropped.
      unavailable: ["browser", "image_gen", "todo", "memory", "session_search"],
      additive: false,
      bundled: 74,
      version: CAPABILITY_BASELINE_VERSION,
    }]);
  });

  test("a bot whose mode wants no host gate keeps the light set: file and code are turned off", async () => {
    // `auto` under the legacy pipeline: the host policy is `off`, no gate answers a write.
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-ungated" }], { permission_mode: "auto", approval_policy_mode: "off" });
    const writes: string[] = [];
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({ written: writes }), runLocked);
    });
    expect(writes).toEqual(["file:false", "code_execution:false", "web:true", "skills:true"]);
    expect(logs).toEqual([expect.objectContaining({
      event: "worker.capability_baseline_applied",
      botId: "bot-ungated",
      gate: "ungated",
      unavailable: [],
      additive: false,
    })]);
    expect(calls.at(-1)?.sql).toContain("update bots set capability_baseline_version");

    // A runtime that does not hold the approval policy keeps the light set whatever the mode.
    const { db: noPolicyDb } = fakeDb([{ ...candidate, bot_id: "bot-no-policy", host_holds_policy: false }]);
    const noPolicyWrites: string[] = [];
    await captureInfo(async () => {
      await reconcileCapabilityBaselines(noPolicyDb, {} as WorkerConfig, undefined, fakeClientFactory({ written: noPolicyWrites }), runLocked);
    });
    expect(noPolicyWrites).toEqual(["file:false", "code_execution:false", "web:true", "skills:true"]);
  });

  test("a gate proof that is stale, missing or for another mode stamps nothing and waits for the recheck", async () => {
    let nowMs = 1_800_000_000_000;
    const clock = () => nowMs;
    const fresh: Partial<FreshRow> = { approval_policy_effective_at: new Date(nowMs - BASELINE_GATE_PROOF_MAX_AGE_MS) };
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-stale-proof" }], fresh, clock);
    const hostWrites: string[] = [];
    const clientFactory = fakeClientFactory({
      written: hostWrites,
      onBundled: async (profile) => { hostWrites.push("bundled"); return { profile, requested: false, bundled: 74, bundledEnabled: 0, applied: true }; },
      onIsolation: async () => { hostWrites.push("isolation"); return "isolated"; },
    });
    const logs = await captureInfo(async (lines) => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, clock);
      expect(lines).toEqual([{ event: "worker.capability_baseline_waiting_policy", botId: "bot-stale-proof", organizationId: "org-1" }]);
      expect(hostWrites).toEqual([]);
      expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
      // Back after the usual backoff; the approval policy recheck has proven the gate meanwhile.
      nowMs += 29_999;
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, clock);
      expect(lines).toHaveLength(1);
      nowMs += 1;
      fresh.approval_policy_effective_at = new Date(nowMs - 1_000);
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, clock);
    });
    expect(logs.map((line) => line.event)).toEqual([
      "worker.capability_baseline_waiting_policy",
      "worker.capability_baseline_applied",
    ]);
    expect(logs[1]).toMatchObject({ gate: "gated", version: CAPABILITY_BASELINE_VERSION });
    expect(calls.at(-1)?.sql).toContain("update bots set capability_baseline_version");

    const waiting: Array<[string, Partial<FreshRow>]> = [
      ["bot-no-proof", { approval_policy_mode: null, approval_policy_effective_at: null }],
      ["bot-proof-off", { approval_policy_mode: "off" }],
      ["bot-plan-proven-ask", { permission_mode: "plan", approval_policy_mode: "ask_writes" }],
    ];
    for (const [botId, row] of waiting) {
      const pending = fakeDb([{ ...candidate, bot_id: botId }], row);
      const writes: string[] = [];
      const lines = await captureInfo(async () => {
        await reconcileCapabilityBaselines(pending.db, {} as WorkerConfig, undefined, fakeClientFactory({
          onToolset: async (_p, name, enabled) => { writes.push(name); return { enabled }; },
          onBundled: async (profile) => { writes.push("bundled"); return { profile, requested: false, bundled: 0, bundledEnabled: 0, applied: true }; },
        }), runLocked);
      });
      expect(lines).toEqual([{ event: "worker.capability_baseline_waiting_policy", botId, organizationId: "org-1" }]);
      expect(writes).toEqual([]);
      expect(pending.calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
    }
  });

  test("a bot stamped at 1 gets the default tools additively: nothing the operator turned on goes off, bundled skills untouched", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-replay-v1" }], { capability_baseline_version: 1 });
    const hostCalls: string[] = [];
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        // The v1 light set, plus `tts` the operator turned on since and a
        // `cronjob` the run contract refuses.
        toolsets: [
          { name: "web", enabled: true },
          { name: "terminal", enabled: true },
          { name: "skills", enabled: true },
          { name: "tts", enabled: true },
          { name: "cronjob", enabled: true },
          ...DEFAULT_BOT_TOOLSETS
            .filter((name) => !["web", "terminal", "skills"].includes(name))
            .map((name) => ({ name, enabled: false })),
        ],
        onBundled: async (profile) => { hostCalls.push("bundled"); return { profile, requested: false, bundled: 74, bundledEnabled: 0, applied: true }; },
      }), runLocked);
    });
    expect(hostCalls).toEqual([]);
    const stamp = calls.at(-1)!;
    expect(stamp.sql).toContain("update bots set capability_baseline_version");
    expect(stamp.values).toEqual([CAPABILITY_BASELINE_VERSION, "org-1", "bot-replay-v1"]);
    expect(logs).toEqual([expect.objectContaining({
      event: "worker.capability_baseline_applied",
      botId: "bot-replay-v1",
      gate: "gated",
      isolated: true,
      additive: true,
      bundled: null,
      unavailable: [],
      toolsetWrites: [
        { name: "cronjob", enabled: false },
        ...DEFAULT_BOT_TOOLSETS
          .filter((name) => !["web", "terminal", "skills"].includes(name))
          .map((name) => ({ name, enabled: true })),
      ],
    })]);
  });

  test("a profile whose isolation is not proven never gets memory or session_search on", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-shared-home" }]);
    const writes: string[] = [];
    let probes = 0;
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        toolsets: [
          { name: "web", enabled: true },
          { name: "terminal", enabled: true },
          { name: "skills", enabled: true },
          { name: "memory", enabled: true },
          { name: "session_search", enabled: false },
        ],
        written: writes,
        onIsolation: async () => { probes += 1; return "not_partitioned"; },
      }), runLocked);
    });
    expect(logs).toEqual([expect.objectContaining({
      event: "worker.capability_baseline_applied",
      isolated: false,
      toolsetWrites: [{ name: "memory", enabled: false }],
    })]);
    // No second probe at the stamp: nothing was opened on the isolation.
    expect(probes).toBe(1);
    expect(writes).toEqual(["memory:false"]);
    expect(calls.at(-1)?.sql).toContain("update bots set capability_baseline_version");
  });

  test("an isolation lost during the writes stamps nothing", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-isolation-lost" }]);
    const answers: HermesProfileIsolation[] = ["isolated", "missing"];
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        onIsolation: async () => answers.shift() ?? "missing",
      }), runLocked);
    });
    expect(logs).toEqual([
      { event: "worker.capability_baseline_failed", botId: "bot-isolation-lost", organizationId: "org-1", code: "PROFILE_UNVERIFIED", status: 502, attempt: 1, stuck: false },
    ]);
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
  });

  test("selects only managed, live bots on a runtime that announces both verbs and is below the version", async () => {
    const { db, calls } = fakeDb([]);
    await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory(), runLocked);
    const select = calls[0]!;
    expect(select.sql).toContain("b.hermes_profile_managed");
    expect(select.sql).toContain("b.deleted_at is null");
    expect(select.sql).toContain("b.capability_baseline_version <");
    expect(select.sql).toContain("rt.link_features @>");
    expect(select.sql).toContain("p.status in ('queued','running')");
    expect(select.sql).toMatch(/rt\.link_features @> array\[ \]::text\[\] as host_holds_policy/);
    expect(select.values).toContain("approval_policy");
    expect(select.values).toContain(CAPABILITY_BASELINE_VERSION);
    expect(select.values).toContain('{"profile_capabilities","profile_bundled_skills"}');
    expect(select.values).toContain(50);
    expect(calls).toHaveLength(1);
  });

  test("a host toolset write that does not apply leaves the version at 0 and backs off", async () => {
    const failing = { ...candidate, bot_id: "bot-unapplied" };
    let nowMs = 1_800_000_000_000;
    const { db, calls } = fakeDb([failing], {}, () => nowMs);
    let toolsetWrites = 0;
    let bundledWrites = 0;
    const clientFactory = fakeClientFactory({
      onToolset: async (_p, _n, enabled) => { toolsetWrites += 1; return { enabled: !enabled }; },
      onBundled: async (profile) => { bundledWrites += 1; return { profile, requested: false, bundled: 1, bundledEnabled: 0, applied: true }; },
    });
    const logs = await captureInfo(async (lines) => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
      expect(lines).toHaveLength(1);
      nowMs += 29_999;
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
      expect(lines).toHaveLength(1);
      nowMs += 1;
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
    });
    expect(logs).toEqual([
      { event: "worker.capability_baseline_failed", botId: "bot-unapplied", organizationId: "org-1", code: "PROFILE_UNVERIFIED", status: 502, attempt: 1, stuck: false },
      { event: "worker.capability_baseline_failed", botId: "bot-unapplied", organizationId: "org-1", code: "PROFILE_UNVERIFIED", status: 502, attempt: 2, stuck: false },
    ]);
    expect(toolsetWrites).toBe(2);
    expect(bundledWrites).toBe(0);
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
  });

  test("a host that never verifies the writes is reported stuck once, then retried every six hours", async () => {
    let nowMs = 1_800_000_000_000;
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-stuck" }], {}, () => nowMs);
    const clientFactory = fakeClientFactory({ onToolset: async (_p, _n, enabled) => ({ enabled: !enabled }) });
    const logs = await captureInfo(async (lines) => {
      for (let pass = 0; pass < 5; pass += 1) {
        await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
        nowMs += 15 * 60_000;
      }
      expect(lines).toHaveLength(5);
      // Within the six hours nothing runs, after them the bot is tried again.
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
      expect(lines).toHaveLength(5);
      nowMs += 6 * 60 * 60_000;
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
    });
    expect(logs.map((line) => [line.event, line.attempt, line.stuck])).toEqual([
      ["worker.capability_baseline_failed", 1, false],
      ["worker.capability_baseline_failed", 2, false],
      ["worker.capability_baseline_failed", 3, false],
      ["worker.capability_baseline_failed", 4, false],
      ["worker.capability_baseline_stuck", 5, true],
      ["worker.capability_baseline_failed", 6, true],
    ]);
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
  });

  test("bundled skills that do not apply leave the version unchanged and log only code and status", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-bundled-partial" }]);
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        onBundled: async (profile) => ({ profile, requested: false, bundled: 74, bundledEnabled: 3, applied: false }),
      }), runLocked);
    });
    expect(logs).toEqual([
      { event: "worker.capability_baseline_failed", botId: "bot-bundled-partial", organizationId: "org-1", code: "PROFILE_UNVERIFIED", status: 502, attempt: 1, stuck: false },
    ]);
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
  });

  test("a host error is logged with its code and status only, and the version stays", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-host-error" }]);
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        onBundled: async () => { throw new HermesClientError("host-specific private text", 502, "HERMES_UNREACHABLE"); },
      }), runLocked);
    });
    expect(logs).toEqual([
      { event: "worker.capability_baseline_failed", botId: "bot-host-error", organizationId: "org-1", code: "HERMES_UNREACHABLE", status: 502, attempt: 1, stuck: false },
    ]);
    expect(JSON.stringify(logs)).not.toContain("host-specific private text");
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
  });

  test("a bot already at the current version under the lock is skipped without any host write", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-current" }], { capability_baseline_version: CAPABILITY_BASELINE_VERSION });
    const locked: string[] = [];
    let writes = 0;
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        onToolset: async (_p, _n, enabled) => { writes += 1; return { enabled }; },
        onBundled: async (profile) => { writes += 1; return { profile, requested: false, bundled: 0, bundledEnabled: 0, applied: true }; },
      }), (org, bot, run) => { locked.push(`${org}:${bot}`); return run(); });
    });
    expect(locked).toEqual(["org-1:bot-current"]);
    expect(writes).toBe(0);
    expect(logs).toEqual([]);
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
  });

  test("a bot deleted before the lock is skipped", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-gone" }], null);
    let writes = 0;
    await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
      onToolset: async (_p, _n, enabled) => { writes += 1; return { enabled }; },
    }), runLocked);
    expect(writes).toBe(0);
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
  });

  test("a profile already at the baseline only needs the bundled skills write", async () => {
    const { db, calls } = fakeDb([{ ...candidate, bot_id: "bot-at-baseline" }]);
    const hostCalls: string[] = [];
    const logs = await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        toolsets: [
          ...DEFAULT_BOT_TOOLSETS.map((name) => ({ name, enabled: true })),
          { name: "tts", enabled: false },
        ],
        onToolset: async (_p, name, enabled) => { hostCalls.push(`toolset:${name}`); return { enabled }; },
        onBundled: async (profile, enabled) => {
          hostCalls.push("bundled");
          return { profile, requested: enabled, bundled: 74, bundledEnabled: 0, applied: true };
        },
      }), runLocked);
    });
    expect(hostCalls).toEqual(["bundled"]);
    expect(logs[0]).toMatchObject({ event: "worker.capability_baseline_applied", toolsetWrites: [], bundled: 74 });
    expect(calls.at(-1)?.sql).toContain("update bots set capability_baseline_version");
  });

  test("a profile missing from the host inventory is not written and is retried after the backoff", async () => {
    const missing = { ...candidate, bot_id: "bot-missing", profile: "old-profile" };
    const { db, calls } = fakeDb([missing]);
    let nowMs = 1_800_000_000_000;
    let inventoryReads = 0;
    let writes = 0;
    const clientFactory = fakeClientFactory({
      onInventory: async () => { inventoryReads += 1; return inventory("another-profile"); },
      onToolset: async (_p, _n, enabled) => { writes += 1; return { enabled }; },
    });
    const logs = await captureInfo(async (lines) => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
      expect(lines).toHaveLength(1);
      nowMs += 30_000;
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, clientFactory, runLocked, () => nowMs);
    });
    expect(logs.map((line) => line.event)).toEqual([
      "worker.capability_baseline_profile_missing",
      "worker.capability_baseline_profile_missing",
    ]);
    expect(logs[0]).toMatchObject({ botId: "bot-missing", organizationId: "org-1", profile: "old-profile" });
    expect(inventoryReads).toBe(2);
    expect(writes).toBe(0);
    expect(calls.some(({ sql }) => sql.includes("update bots"))).toBe(false);
  });

  test("shares the pass inventory per runtime, and re-reads the profile under the lock before and after its writes", async () => {
    const first = { ...candidate, bot_id: "bot-shared-a" };
    const second = { ...candidate, bot_id: "bot-shared-b" };
    const { db } = fakeDb([first, second]);
    let inventoryReads = 0;
    await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        onInventory: async () => { inventoryReads += 1; return inventory(candidate.profile, heavyToolsets); },
      }), runLocked);
    });
    // 1 shared read for the pass, then per bot 1 fresh read under the lock and
    // 1 verification read; the static host never shows the writes, so neither
    // bot is stamped.
    expect(inventoryReads).toBe(1 + 2 * 2);
  });

  test("never writes a forbidden toolset on, and stops at an aborted signal", async () => {
    const { db } = fakeDb([{ ...candidate, bot_id: "bot-forbidden" }]);
    const writes: string[] = [];
    await captureInfo(async () => {
      await reconcileCapabilityBaselines(db, {} as WorkerConfig, undefined, fakeClientFactory({
        toolsets: [
          { name: "web", enabled: true },
          { name: "terminal", enabled: true },
          { name: "skills", enabled: true },
          { name: "cronjob", enabled: true },
          { name: "delegation", enabled: true },
        ],
        onToolset: async (_p, name, enabled) => { writes.push(`${name}:${enabled}`); return { enabled }; },
      }), runLocked);
    });
    expect(writes).toEqual(["cronjob:false", "delegation:false"]);

    const aborted = new AbortController();
    aborted.abort();
    const { db: abortedDb, calls } = fakeDb([{ ...candidate, bot_id: "bot-aborted" }]);
    await reconcileCapabilityBaselines(abortedDb, {} as WorkerConfig, aborted.signal, fakeClientFactory(), runLocked);
    expect(calls).toHaveLength(1);
  });
});

describe("capability baseline during the provision", () => {
  const job = { organization_id: "org-1", bot_id: "bot-new", runtime_id: "runtime-1" };

  /** `fakeDb`, plus the provision's own bot and runtime read (`target`, or none). */
  function provisionDb(target: { profile: string; host_holds_policy: boolean; toolsets_batch?: boolean } | null, fresh: Partial<FreshRow> = {}) {
    const base = fakeDb([], fresh);
    const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      if ([...parts].join(" ").includes("select b.hermes_profile as profile")) {
        base.calls.push({ sql: [...parts].join(" "), values });
        return Promise.resolve(target ? [target] : []);
      }
      return (base.db as unknown as (parts: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>)(parts, ...values);
    }) as unknown as SQL;
    return { db, calls: base.calls };
  }

  test("applies the baseline to the served profile under the lock, and stamps the version", async () => {
    const { db, calls } = provisionDb({ profile: "scout", host_holds_policy: true });
    const written: string[] = [];
    const locked: string[] = [];
    let outcome: string | undefined;
    const logs = await captureInfo(async () => {
      outcome = await provisionCapabilityBaseline(db, {} as WorkerConfig, job, fakeClientFactory({ written }), async (org, bot, run) => {
        locked.push(`${org}:${bot}`);
        return run();
      });
    });
    expect(outcome).toBe("applied");
    expect(locked).toEqual(["org-1:bot-new"]);
    expect(written).toEqual(["web:true", "vision:true", "skills:true"]);
    const read = calls.find((call) => call.sql.includes("select b.hermes_profile as profile"))!;
    expect(read.sql).toContain("rt.reachability = 'connector'");
    expect(read.values).toContain("runtime-1");
    expect(calls.at(-1)!.values).toEqual([CAPABILITY_BASELINE_VERSION, "org-1", "bot-new"]);
    expect(logs[0]).toMatchObject({ event: "worker.capability_baseline_applied", botId: "bot-new", gate: "gated", during: "provision" });
  });

  test("a runtime without the baseline verbs or an unmanaged profile is left to the reconciliation", async () => {
    const { db } = provisionDb(null);
    let created = false;
    const factory = (() => { created = true; return {}; }) as unknown as typeof createRuntimeClient;
    expect(await provisionCapabilityBaseline(db, {} as WorkerConfig, job, factory, runLocked)).toBe("unsupported");
    expect(created).toBe(false);
  });

  test("an unproven gate or a bot already at the version writes nothing", async () => {
    for (const [fresh, expected] of [
      [{ approval_policy_effective_at: null }, "pending"],
      [{ capability_baseline_version: CAPABILITY_BASELINE_VERSION }, "current"],
    ] as const) {
      const { db } = provisionDb({ profile: "scout", host_holds_policy: true }, fresh);
      const written: string[] = [];
      expect(await provisionCapabilityBaseline(db, {} as WorkerConfig, job, fakeClientFactory({ written }), runLocked)).toBe(expected);
      expect(written).toEqual([]);
    }
  });

  test("a host that announces profile_toolsets_batch takes the baseline's toolsets in one write", async () => {
    const { db, calls } = provisionDb({ profile: "scout", host_holds_policy: true, toolsets_batch: true });
    const written: string[] = [];
    const batches: Array<Record<string, boolean>> = [];
    let outcome: string | undefined;
    await captureInfo(async () => {
      outcome = await provisionCapabilityBaseline(db, {} as WorkerConfig, job, fakeClientFactory({ written, batches }), runLocked);
    });
    expect(outcome).toBe("applied");
    expect(written).toEqual([]);
    expect(batches).toEqual([{ web: true, vision: true, skills: true }]);
    const read = calls.find((call) => call.sql.includes("select b.hermes_profile as profile"))!;
    expect(read.sql).toContain("as toolsets_batch");
    expect(read.values).toContain("profile_toolsets_batch");
    expect(calls.at(-1)!.values).toEqual([CAPABILITY_BASELINE_VERSION, "org-1", "bot-new"]);
  });

  test("announces the toolsets it enables, settable ones only, before writing them (0164)", async () => {
    const { db } = provisionDb({ profile: "scout", host_holds_policy: true, toolsets_batch: true });
    const order: string[] = [];
    const batches: Array<Record<string, boolean>> = [];
    const factory = fakeClientFactory({ written: [], batches });
    await captureInfo(async () => {
      await provisionCapabilityBaseline(db, {} as WorkerConfig, job, factory, runLocked, undefined, {
        onTools: async (names) => { order.push(`tools:${names.join(",")}`); expect(batches).toEqual([]); },
      });
    });
    // Every toolset the bot will have on, already-on ones included; never one the host cannot set.
    expect(order).toEqual(["tools:web,terminal,file,code_execution,vision,skills"]);
    expect(batches).toEqual([{ web: true, vision: true, skills: true }]);
  });

  test("a settable list read before the profile creation is used, and a failed one is read again", async () => {
    for (const [prefetched, reads] of [[new Set(["web", "vision", "skills", "terminal"]), 0], [null, 1]] as const) {
      const { db } = provisionDb({ profile: "scout", host_holds_policy: true });
      const written: string[] = [];
      let settableReads = 0;
      const factory = fakeClientFactory({
        written,
        onSettable: async () => { settableReads += 1; return { platform: "api_server", settable: ["web", "vision", "skills", "terminal"] }; },
      });
      let outcome: string | undefined;
      await captureInfo(async () => {
        outcome = await provisionCapabilityBaseline(db, {} as WorkerConfig, job, factory, runLocked, undefined, { settable: Promise.resolve(prefetched) });
      });
      expect(outcome).toBe("applied");
      expect(settableReads).toBe(reads);
      expect(written).toEqual(["web:true", "vision:true", "skills:true"]);
    }
  });

  test("bundled skills the creation proved off are not written again, and the version is stamped", async () => {
    const { db, calls } = provisionDb({ profile: "scout", host_holds_policy: true, toolsets_batch: true });
    let bundledWrites = 0;
    const factory = fakeClientFactory({ onBundled: async (profile, enabled) => {
      bundledWrites += 1;
      return { profile, requested: enabled, bundled: 74, bundledEnabled: 0, applied: true };
    } });
    let outcome: string | undefined;
    await captureInfo(async () => {
      outcome = await provisionCapabilityBaseline(db, {} as WorkerConfig, job, factory, runLocked, undefined, { bundledSkillsOff: true });
    });
    expect(outcome).toBe("applied");
    expect(bundledWrites).toBe(0);
    expect(calls.at(-1)!.values).toEqual([CAPABILITY_BASELINE_VERSION, "org-1", "bot-new"]);
  });

  test("a profile the gateway does not serve is not written, and the version is not stamped", async () => {
    const { db, calls } = provisionDb({ profile: "scout", host_holds_policy: true, toolsets_batch: true });
    const batches: Array<Record<string, boolean>> = [];
    const factory = fakeClientFactory({ batches, onInventory: async () => inventory("another-profile") });
    await expect(provisionCapabilityBaseline(db, {} as WorkerConfig, job, factory, runLocked)).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND" });
    expect(batches).toEqual([]);
    expect(calls.some((call) => call.sql.includes("update bots set capability_baseline_version"))).toBe(false);
  });

  test("a batch answer that does not show a write is unverified, and the version is not stamped", async () => {
    const { db, calls } = provisionDb({ profile: "scout", host_holds_policy: true, toolsets_batch: true });
    const factory = fakeClientFactory({
      onToolsets: async (_profile, toolsets) => Object.keys(toolsets).map((name) => ({ name, enabled: name !== "vision" })),
    });
    await expect(provisionCapabilityBaseline(db, {} as WorkerConfig, job, factory, runLocked)).rejects.toMatchObject({ code: "PROFILE_UNVERIFIED" });
    expect(calls.some((call) => call.sql.includes("update bots set capability_baseline_version"))).toBe(false);
  });
});
