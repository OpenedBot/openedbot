import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { claimProfileProvision, executeProfileProvision, type ProfileProvisionClient } from "../src/application/profile-provisions";
import type { ProfileProvisionRow } from "../src/sql/profile-provisions";
import { assertBotProfileSettled, assertProvisionRestorable, cancelProfileProvision, retryBotProfileProvision } from "../src/application/profile-provisions";
import type { TransactionDb } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { HermesClientError } from "@openedbot/hermes";

type HermesClientErrorCode = ConstructorParameters<typeof HermesClientError>[2];
import type { BotRow } from "../src/domain/bot-dto";

const baseJob: ProfileProvisionRow = {
  bot_id: "bot-1",
  organization_id: "org-1",
  runtime_id: "runtime-1",
  slug: "scout",
  display_name: "Scout",
  provider: "anthropic",
  model: "model-1",
  status: "running",
  attempts: 0,
  host_create_attempted: true,
  host_profile_ownership: "unknown",
  lease_owner: "worker-1",
  lease_generation: 4,
  lease_expires_at: new Date(Date.now() + 60_000),
};

/** Each statement answers by its role: lease renewal, terminal update, or row lookup. */
function scriptedDb(options: { leaseHeld?: boolean; finishOwned?: boolean; rowExists?: boolean; permissionMode?: "manual" | "plan" | "auto" | "bypass" } = {}) {
  const { leaseHeld = true, finishOwned = true, rowExists = true, permissionMode = "manual" } = options;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...parts].join(" ");
    statements.push({ sql, values });
    if (sql.includes("host_create_attempted = host_create_attempted or")) return Promise.resolve(leaseHeld ? [{ bot_id: "bot-1" }] : []);
    if (sql.includes("select bot_id from bot_profile_provisions")) return Promise.resolve(rowExists ? [{ bot_id: "bot-1" }] : []);
    if (sql.includes("select b.permission_mode, o.permission_pipeline")) return Promise.resolve([{ permission_mode: permissionMode, permission_pipeline: "legacy" }]);
    return Promise.resolve(finishOwned ? [{ bot_id: "bot-1" }] : []);
  }) as unknown as SQL;
  (db as unknown as { begin: (callback: (tx: SQL) => Promise<unknown>) => Promise<unknown> }).begin = async (callback) => callback(db);
  return { db, statements };
}

function scriptedClient(script: { inventory: Array<boolean | "error">; createError?: HermesClientErrorCode; features?: string[]; featuresError?: boolean; bundledAnswer?: { profile: string; applied: boolean }; policyError?: boolean; readBack?: "profile" | "other-profile"; served?: Array<"isolated" | "missing" | "not_partitioned" | "error"> }) {
  const calls: string[] = [];
  let read = 0;
  let probes = 0;
  let approvalMode = "ask_writes";
  return {
    calls,
    hostCreateProfile: async (slug: string, options: { displayName: string; provider?: string; model?: string; bundledSkills?: false }) => {
      calls.push(`create:${slug}:${options.provider}:${options.model}${options.bundledSkills === false ? ":bundled-off" : ""}`);
      if (script.createError) throw new HermesClientError("exists", 409, script.createError);
      const bundledSkills = script.bundledAnswer ? { requested: false, bundled: 74, bundledEnabled: 3, ...script.bundledAnswer } : undefined;
      if (script.readBack) return { name: script.readBack === "profile" ? slug : "someone-else", readBack: "profile", bundledSkills };
      return bundledSkills ? { name: slug, bundledSkills } : undefined;
    },
    hostProfileInventory: async () => {
      calls.push("inventory");
      const answer = script.inventory[Math.min(read++, script.inventory.length - 1)];
      if (answer === "error") throw new HermesClientError("unreachable", 502, "HERMES_UNREACHABLE");
      return { profiles: answer ? [{ name: "scout" }] : [] };
    },
    hostDeleteProfile: async (slug: string) => { calls.push(`delete:${slug}`); },
    hostCapabilities: async () => {
      calls.push("capabilities");
      if (script.featuresError) throw new HermesClientError("down", 502, "HOST_UNAVAILABLE");
      return script.features ?? [];
    },
    hostSetApprovalPolicy: async (_slug: string, mode: string) => {
      calls.push(`approval:${mode}`);
      if (script.policyError) throw new HermesClientError("unverified", 502, "APPROVAL_POLICY_UNVERIFIED");
      approvalMode = mode;
      return { mode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] };
    },
    hostApprovalPolicy: async (_slug: string) => { calls.push("approval:readback"); return { mode: approvalMode, pluginEnabled: true, effective: true, gateIdentity: true, blockedTools: [] }; },
    probeProfileIsolation: async (_slug: string) => {
      calls.push("served");
      const served = script.served ?? ["isolated"];
      const answer = served[Math.min(probes++, served.length - 1)];
      if (answer === "error") throw new HermesClientError("unreachable", 502, "HERMES_UNREACHABLE");
      return answer;
    },
  } as unknown as ProfileProvisionClient & { calls: string[] };
}

describe("durable bot profile provisioning", () => {
  test("waits to claim a profile name while its old host cleanup is active", async () => {
    let statement = "";
    const db = ((parts: TemplateStringsArray) => {
      statement = [...parts].join(" ");
      return Promise.resolve([]);
    }) as unknown as SQL;
    expect(await claimProfileProvision(db, "worker-1")).toBeNull();
    expect(statement).toContain("bot_host_cleanups cleanup");
    expect(statement).toContain("cleanup.status in ('queued','running')");
    // Une suppression déjà prouvée ne fait plus attendre (0150) : avant, la
    // vérification à 60 s retenait un bot recréé sous le même nom.
    expect(statement).toContain("cleanup.profile_removed_at is null");
  });

  test("retry changes only a failed provision back to preparing", async () => {
    const statements: string[] = [];
    const row = {
      id: "bot-1", threadId: "thread-1", name: "Scout", slug: "scout", description: null,
      instructions: "", model: null, reasoningEffort: null, sectionId: "section-1", position: 0,
      pinned: false, face: null, voiceId: null, label: null, replyLanguage: "auto", notifyOnFinish: true,
      speechRate: "1", permissionMode: "manual", hermesProfile: "scout", archivedAt: null, deletedAt: null,
      createdAt: new Date(), updatedAt: new Date(), awaitingApproval: false, preview: null,
      lastActivityAt: new Date(), lastRunAt: null, autonomyEnabled: false, autonomyMaxDepth: 3,
      autonomyMaxSteps: 8, autonomyMaxHandoffs: 4, autonomyTimeoutSeconds: 1800, autonomyTokenBudget: 120000,
    } satisfies BotRow;
    const tx = ((parts: TemplateStringsArray) => {
      const sql = [...parts].join(" ");
      statements.push(sql);
      if (sql.includes("update bot_profile_provisions")) return Promise.resolve([{ bot_id: "bot-1" }]);
      if (sql.includes('t.id as "threadId"')) return Promise.resolve([row]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback) => callback(tx);
    const result = await retryBotProfileProvision(tx, "org-1", "bot-1");
    expect(result.profileProvisionStatus).toBe("preparing");
    expect(statements.some((sql) => sql.includes("status = 'failed'"))).toBe(true);
  });

  test("retry refuses a provision that is not failed", async () => {
    const tx = ((parts: TemplateStringsArray) => {
      const sql = [...parts].join(" ");
      return Promise.resolve(sql.includes("select status, host_profile_ownership as ownership from bot_profile_provisions") ? [{ status: "queued", ownership: "unknown" }] : []);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback) => callback(tx);
    await expect(retryBotProfileProvision(tx, "org-1", "bot-1")).rejects.toMatchObject({
      status: 409,
      code: "PROFILE_PROVISION_NOT_FAILED",
    } satisfies Partial<HttpError>);
  });

  test("marks success only after inventory confirms the slug", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory", "create:scout:anthropic:model-1", "inventory", "served"]);
    expect(statements.at(-1)?.values[0]).toBe("succeeded");
    expect(statements.filter((statement) => statement.sql.includes("update bot_profile_provisions")).every((statement) => statement.sql.includes("lease_generation ="))).toBe(true);
  });

  test("a host that read the created profile back spares the inventory read (DEV-OHB-244)", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false], readBack: "profile" });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory", "create:scout:anthropic:model-1", "served"]);
    expect(statements.at(-1)?.values[0]).toBe("succeeded");
  });

  test("a read-back that names another profile is not a proof: the inventory decides", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true], readBack: "other-profile" });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory", "create:scout:anthropic:model-1", "inventory", "served"]);
    expect(statements.at(-1)?.values[0]).toBe("succeeded");
  });

  test("applies announced permission policy after proving the profile and before success", async () => {
    const { db, statements } = scriptedDb({ permissionMode: "manual" });
    const client = scriptedClient({ inventory: [false, true], features: ["approval_policy"] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory", "create:scout:anthropic:model-1", "inventory", "approval:ask_writes", "approval:readback", "served"]);
    expect(statements.at(-1)?.values[0]).toBe("succeeded");
  });

  test("succeeds only once the gateway serves the new profile (DEV-OHB-244)", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true], served: ["missing", "error", "isolated"] });
    const slept: number[] = [];
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, {
      client: () => client,
      serveWait: { timeoutMs: 60_000, pollMs: 7, sleep: async (ms) => { slept.push(ms); } },
    });
    expect(client.calls.filter((call) => call === "served")).toHaveLength(3);
    expect(slept).toEqual([7, 7]);
    expect(statements.at(-1)?.values[0]).toBe("succeeded");
  });

  test("a new bot with a baseline asks the creation to turn the bundled skills off, and passes only a proven answer on", async () => {
    const required = ["approval_policy", "profile_capabilities", "profile_bundled_skills"];
    for (const [bundledAnswer, expected] of [
      [{ profile: "scout", applied: true }, true],
      [{ profile: "scout", applied: false }, false],
      [{ profile: "other", applied: true }, false],
      [undefined, false],
    ] as const) {
      const { db } = scriptedDb();
      const client = scriptedClient({ inventory: [false, true], features: required, bundledAnswer });
      const seen: boolean[] = [];
      await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, {
        client: () => client,
        baseline: async (_job, _timings, created) => { seen.push(created.bundledSkillsOff); return "applied"; },
      });
      expect(client.calls).toContain("create:scout:anthropic:model-1:bundled-off");
      expect(seen).toEqual([expected]);
    }
  });

  test("without the baseline verbs, or without a baseline, the creation leaves the bundled skills alone", async () => {
    for (const [features, withBaseline] of [[["approval_policy"], true], [["approval_policy", "profile_capabilities", "profile_bundled_skills"], false]] as const) {
      const { db } = scriptedDb();
      const client = scriptedClient({ inventory: [false, true], features: [...features] });
      await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, {
        client: () => client,
        ...(withBaseline ? { baseline: async () => "applied" } : {}),
      });
      expect(client.calls).toContain("create:scout:anthropic:model-1");
    }
  });

  test("publishes its steps for the waiting screen, under its lease: space, rules, tools then their names (0164)", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true], features: ["approval_policy"] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, {
      client: () => client,
      baseline: async (_job, _timings, created) => { await created.onTools(["web", "terminal", "skills"]); return "applied"; },
    });
    const writes = statements.filter((statement) => statement.sql.includes("set progress ="));
    expect(writes.map((statement) => statement.values[0])).toEqual([
      { step: "space" },
      { step: "rules" },
      { step: "tools" },
      { step: "tools", tools: ["web", "terminal", "skills"] },
    ]);
    for (const write of writes) expect(write.sql).toContain("lease_owner =");
    expect(statements.at(-1)!.values[0]).toBe("succeeded");
  });

  test("a progress write that fails never fails the profile", async () => {
    const { db, statements } = scriptedDb();
    const failing = ((parts: TemplateStringsArray, ...values: unknown[]) =>
      [...parts].join(" ").includes("set progress =") ? Promise.reject(new Error("db down")) : (db as unknown as (p: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(parts, ...values)) as unknown as SQL;
    (failing as unknown as { begin: unknown }).begin = (db as unknown as { begin: unknown }).begin;
    const client = scriptedClient({ inventory: [false, true], features: ["approval_policy"] });
    await executeProfileProvision(failing, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(statements.at(-1)!.values[0]).toBe("succeeded");
  });

  test("applies the capability baseline once the profile is served, before success", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true], features: ["approval_policy"] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, {
      client: () => client,
      baseline: async (job) => { client.calls.push(`baseline:${job.bot_id}`); return "applied"; },
    });
    expect(client.calls.slice(-2)).toEqual(["served", "baseline:bot-1"]);
    const closing = statements.at(-1)!;
    expect(closing.values[0]).toBe("succeeded");
    const timings = closing.values.find((value) => typeof value === "object" && value !== null && "totalMs" in value) as Record<string, unknown>;
    expect(typeof timings.baselineMs).toBe("number");
  });

  test("a baseline that fails or waits does not hold the profile back: the reconciliation retries it", async () => {
    for (const baseline of [async () => { throw new HermesClientError("down", 502, "HERMES_UNREACHABLE"); }, async () => "pending"]) {
      const { db, statements } = scriptedDb();
      const client = scriptedClient({ inventory: [false, true] });
      const lines: string[] = [];
      const originalInfo = console.info;
      console.info = (line: string) => { lines.push(line); };
      try {
        await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client, baseline });
      } finally {
        console.info = originalInfo;
      }
      expect(statements.at(-1)?.values[0]).toBe("succeeded");
      const deferred = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "profile_provision.baseline_deferred");
      expect(deferred?.outcome).toBe(deferred?.code ? "failed" : "pending");
      expect(JSON.stringify(deferred)).not.toContain("down");
    }
  });

  test("a profile the gateway does not serve gets no baseline", async () => {
    const { db } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true], served: ["missing"] });
    let called = false;
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, {
      client: () => client,
      serveWait: { timeoutMs: 0, pollMs: 1, sleep: async () => {} },
      baseline: async () => { called = true; return "applied"; },
    });
    expect(called).toBe(false);
  });

  test("closes the pass with its step durations, names and milliseconds only (0151)", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true] });
    const created = new Date("2026-10-27T13:44:00.000Z");
    await executeProfileProvision(db, {
      ...baseJob, host_create_attempted: false, created_at: created, updated_at: new Date(created.getTime() + 1_500),
    }, { client: () => client });
    const closing = statements.at(-1)!;
    expect(closing.sql).toContain("timings =");
    const timings = closing.values.find((value) => typeof value === "object" && value !== null && "totalMs" in value) as Record<string, unknown>;
    expect(timings.claimedAfterMs).toBe(1_500);
    for (const step of ["precheckMs", "createMs", "proofMs", "approvalMs", "serveMs", "totalMs"]) {
      expect(typeof timings[step]).toBe("number");
    }
    expect(timings.attempt).toBe(1);
    expect(Object.values(timings).every((value) => typeof value === "number")).toBe(true);
  });

  test("retries a provision whose profile the gateway never serves", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true], served: ["missing"] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, {
      client: () => client,
      serveWait: { timeoutMs: 0, pollMs: 1, sleep: async () => undefined },
    });
    expect(statements.at(-1)?.values[0]).toBe("queued");
  });

  test("retries provisioning when the announced approval policy cannot be proven", async () => {
    const { db, statements } = scriptedDb({ permissionMode: "plan" });
    const client = scriptedClient({ inventory: [false, true], features: ["approval_policy"], policyError: true });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls.at(-1)).toBe("approval:block_writes");
    expect(statements.at(-1)?.values[0]).toBe("queued");
  });

  test("host features read during the creation and failed leave the policy unproven and retry, never served", async () => {
    const { db, statements } = scriptedDb({ permissionMode: "plan" });
    const client = scriptedClient({ inventory: [false, true], featuresError: true });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory", "create:scout:anthropic:model-1", "inventory"]);
    expect(statements.at(-1)?.values[0]).toBe("queued");
  });

  test("retries with attempts and terminates on the third unproven attempt", async () => {
    const statuses: unknown[] = [];
    for (const attempts of [0, 1, 2]) {
      const { db, statements } = scriptedDb();
      const client = scriptedClient({ inventory: [false] });
      await executeProfileProvision(db, { ...baseJob, attempts }, { client: () => client });
      statuses.push(statements.at(-1)?.values[0]);
    }
    expect(statuses).toEqual(["queued", "queued", "failed"]);
  });

  test("never adopts a profile already present before any create call", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [true] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory"]);
    expect(statements.at(-1)?.values[0]).toBe("failed");
    expect(JSON.stringify(statements.at(-1)?.values)).toContain("PROFILE_SLUG_TAKEN");
  });

  test("an unreadable inventory is not absence: no create, retry later", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: ["error"] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory"]);
    expect(statements.at(-1)?.values[0]).toBe("queued");
  });

  test("PROFILE_EXISTS on the first create call is refused, not adopted", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false, true], createError: "PROFILE_EXISTS" });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory", "create:scout:anthropic:model-1"]);
    expect(JSON.stringify(statements.at(-1)?.values)).toContain("PROFILE_SLUG_TAKEN");
  });

  test("a resumed attempt may adopt PROFILE_EXISTS once inventory lists it", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [true], createError: "PROFILE_EXISTS" });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: true }, { client: () => client });
    expect(statements.at(-1)?.values[0]).toBe("succeeded");
  });

  test("an expired lease stops before any host write", async () => {
    const { db } = scriptedDb({ leaseHeld: false });
    const client = scriptedClient({ inventory: [false] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory"]);
  });

  test("a provision cancelled during the call removes the profile it created", async () => {
    const { db } = scriptedDb({ finishOwned: false, rowExists: false });
    const client = scriptedClient({ inventory: [false, true] });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory", "create:scout:anthropic:model-1", "inventory", "served", "delete:scout"]);
  });

  test("cancellation waits for a live worker, keeps a tombstone, and never claims a foreign profile", async () => {
    const noWait = { timeoutMs: 0, pollMs: 0, sleep: async () => undefined };
    const run = async (row: Record<string, unknown> | null) => {
      const statements: string[] = [];
      const tx = ((parts: TemplateStringsArray) => {
        const sql = [...parts].join(" ");
        statements.push(sql);
        return Promise.resolve(sql.includes("for update") ? (row ? [row] : []) : []);
      }) as unknown as SQL;
      (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
      return { result: cancelProfileProvision(tx, "org-1", "bot-1", noWait), statements };
    };
    await expect((await run({ status: "running", live: true, attempted: true, ownership: "unknown" })).result).rejects.toMatchObject({ status: 409, code: "BOT_PROFILE_PREPARING" });
    expect(await (await run(null)).result).toEqual({ hostProfileOwned: true });
    expect(await (await run({ status: "failed", live: false, attempted: false, ownership: "foreign" })).result).toEqual({ hostProfileOwned: false });
    expect(await (await run({ status: "queued", live: false, attempted: false, ownership: "unknown" })).result).toEqual({ hostProfileOwned: false });
    const resumed = await run({ status: "failed", live: false, attempted: true, ownership: "unknown" });
    expect(await resumed.result).toEqual({ hostProfileOwned: true });
    expect(resumed.statements.some((sql) => sql.includes("set status = 'cancelled'"))).toBe(true);
    expect(resumed.statements.some((sql) => sql.includes("delete"))).toBe(false);
    const again = await run({ status: "cancelled", live: false, attempted: false, ownership: "foreign" });
    expect(await again.result).toEqual({ hostProfileOwned: false });
    expect(again.statements.some((sql) => sql.includes("set status = 'cancelled'"))).toBe(false);
  });

  test("deleting during a live profile creation waits for it, then owns the created profile (DEV-OHB-244)", async () => {
    const rows = [
      { status: "running", live: true, attempted: true, ownership: "unknown" },
      { status: "running", live: true, attempted: true, ownership: "unknown" },
      { status: "succeeded", live: false, attempted: true, ownership: "ours" },
    ];
    const tx = ((parts: TemplateStringsArray) =>
      Promise.resolve([...parts].join(" ").includes("for update") ? [rows.shift()] : [])) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
    let slept = 0;
    const result = await cancelProfileProvision(tx, "org-1", "bot-1", { timeoutMs: 60_000, pollMs: 1, sleep: async () => { slept += 1; } });
    expect(result).toEqual({ hostProfileOwned: true });
    expect(slept).toBe(2);
  });

  test("a foreign profile name can be neither retried nor restored", async () => {
    const tx = ((parts: TemplateStringsArray) => {
      const sql = [...parts].join(" ");
      if (sql.includes("update bot_profile_provisions")) return Promise.resolve([]);
      return Promise.resolve([{ status: sql.includes("host_profile_ownership as ownership from bot_profile_provisions where") ? "failed" : "cancelled", ownership: "foreign" }]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
    await expect(retryBotProfileProvision(tx, "org-1", "bot-1")).rejects.toMatchObject({ status: 409, code: "PROFILE_SLUG_TAKEN" });
    await expect(assertProvisionRestorable(tx, "org-1", "bot-1")).rejects.toMatchObject({ status: 409, code: "PROFILE_SLUG_TAKEN" });
  });

  test("a definitive host refusal clears the presumption that a later profile is ours", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false], createError: "HERMES_LIMIT_REACHED" });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    const last = statements.at(-1)!;
    expect(last.sql).toContain("host_create_attempted = host_create_attempted and not");
    expect(last.values).toContain(true);
    expect(last.values[0]).toBe("queued");
  });

  test("a profile name the host refuses fails at once instead of retrying", async () => {
    const { db, statements } = scriptedDb();
    const client = scriptedClient({ inventory: [false], createError: "PROFILE_INVALID" as HermesClientErrorCode });
    await executeProfileProvision(db, { ...baseJob, host_create_attempted: false }, { client: () => client });
    expect(client.calls).toEqual(["capabilities", "inventory", "create:scout:anthropic:model-1"]);
    const last = statements.at(-1)!;
    expect(last.values[0]).toBe("failed");
    expect(JSON.stringify(last.values)).toContain("PROFILE_NAME_REFUSED");
  });

  test("restoring a never-created profile requires the name to be free on the host", async () => {
    const tx = ((parts: TemplateStringsArray) => Promise.resolve(
      [...parts].join(" ").includes("host_create_attempted as attempted") ? [{ status: "cancelled", ownership: "unknown", attempted: false }] : [],
    )) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
    expect(await assertProvisionRestorable(tx, "org-1", "bot-1")).toEqual({ cancelled: true, mustBeAbsent: true });
  });
});

describe("assertBotProfileSettled", () => {
  const txAnswering = (rows: Array<{ status: string }>) => {
    const seen: string[] = [];
    const tx = ((parts: TemplateStringsArray) => { seen.push([...parts].join(" ")); return Promise.resolve(rows); }) as unknown as TransactionDb;
    return { tx, seen };
  };

  test("a bot whose profile is queued or being created cannot be deleted yet: 409, at once", async () => {
    const { tx, seen } = txAnswering([{ status: "running" }]);
    await expect(assertBotProfileSettled(tx, "org-1", "bot-1")).rejects.toMatchObject({ status: 409, code: "BOT_PROFILE_PREPARING" });
    expect(seen[0]).toContain("status in ('queued', 'running')");
  });

  test("a ready, failed or provision-less bot can be deleted", async () => {
    const { tx } = txAnswering([]);
    await expect(assertBotProfileSettled(tx, "org-1", "bot-1")).resolves.toBeUndefined();
  });
});
