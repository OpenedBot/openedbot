import { describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { HermesClientError, type HermesClient } from "@openedbot/hermes";
import { canaryReasoningEffort, executeRuntimeModelSelectionProof, proveManagedRuntimeModelSelection, proveRuntimeModelSelection, type ModelProofJob } from "../src/application/model-selection-proof";

function modelJob(overrides: Partial<ModelProofJob> = {}): ModelProofJob {
  return {
    runtime_id: "runtime-1", organization_id: "org-1", provider: "anthropic", model: "claude-sonnet-4",
    reasoning_effort: "low", status: "running", request_generation: 1, request_id: "request-a", attempts: 1, next_attempt_at: new Date(),
    error: null, lease_owner: "worker-1", lease_generation: 1, lease_token: "lease-a", lease_expires_at: new Date(Date.now() + 240_000),
    requested_at: new Date(), reachability: "connector", endpoint: null, token_ciphertext: null, token_nonce: null,
    token_tag: null, token_key_id: null, edge_auth_ciphertext: null, edge_auth_nonce: null, edge_auth_tag: null,
    edge_auth_key_id: null, link_features: [], ...overrides,
  };
}

function fakeDb(current: { request_id: string; lease_token: string | null; attempts: number; requested_at: Date }) {
  const writes: string[] = [];
  const tx = (async (strings: TemplateStringsArray) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    writes.push(sql);
    if (sql.includes("select request_id, lease_token")) return [current];
    if (sql.includes("select model_assignment_mode")) return [{ model_assignment_mode: "per_bot" }];
    return [];
  }) as unknown as SQL;
  (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin = async (callback) => callback(tx as unknown as Bun.TransactionSQL);
  return { db: tx, writes };
}

function canaryClient(options: { output?: string; runError?: Error } = {}) {
  const calls: string[] = [];
  const client = {
    createRun: async () => { calls.push("run:create"); if (options.runError) throw options.runError; return "run-1"; },
    getRunStatus: async () => ({ status: "completed", output: options.output ?? "OK" }),
    stopRun: async () => { calls.push("run:stop"); },
    deleteSession: async () => { calls.push("session:delete"); },
  } as unknown as HermesClient;
  return { client, calls };
}

describe("runtime model selection proof", () => {
  test("only a completed run with non-empty output proves a selection", async () => {
    const { client, calls } = canaryClient();
    await proveRuntimeModelSelection(client, { provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: null });
    expect(calls).toEqual(["run:create", "session:delete"]);
    const empty = canaryClient({ output: "  " });
    await expect(proveRuntimeModelSelection(empty.client, { provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: null }))
      .rejects.toMatchObject({ code: "RUNTIME_MODEL_CANARY_EMPTY" });
  });

  test("canary effort keeps none, minimal, low and null, and reduces higher effort to low", async () => {
    expect([null, "none", "minimal", "low", "medium", "high"].map(canaryReasoningEffort))
      .toEqual([null, "none", "minimal", "low", "low", "low"]);
  });

  test("a timed-out canary stops its run", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(0);
    const sleep = spyOn(Bun, "sleep").mockImplementation(async () => {
      clock.mockReturnValue(45_000);
    });
    const stopped: string[] = [];
    try {
      await expect(proveRuntimeModelSelection({
        createRun: async () => "run-timeout",
        getRunStatus: async () => ({ status: "running", output: null }),
        stopRun: async (runId: string) => { stopped.push(runId); },
        deleteSession: async () => undefined,
      } as unknown as HermesClient, { provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: null }))
        .rejects.toMatchObject({ status: 504, code: "RUNTIME_MODEL_CANARY_TIMEOUT" });
      expect(stopped).toEqual(["run-timeout"]);
    } finally {
      sleep.mockRestore();
      clock.mockRestore();
    }
  });

  test("failed and cancelled runs map to RUNTIME_MODEL_CANARY_FAILED and erase their sessions", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const deleted: string[] = [];
      await expect(proveRuntimeModelSelection({
        createRun: async () => `run-${status}`,
        getRunStatus: async () => ({ status, output: null }),
        stopRun: async () => undefined,
        deleteSession: async (sessionId: string) => { deleted.push(sessionId); },
      } as unknown as HermesClient, { provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: null }))
        .rejects.toMatchObject({ status: 409, code: "RUNTIME_MODEL_CANARY_FAILED" });
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toStartWith("ohb-model-canary-");
    }
  });

  test("successful execution promotes and deletes its pending row", async () => {
    const fake = fakeDb({ request_id: "request-a", lease_token: "lease-a", attempts: 1, requested_at: new Date() });
    const { client } = canaryClient();
    await executeRuntimeModelSelectionProof(fake.db as never, modelJob(), {
      client: () => client,
      withProfileNamesLock: async (_org, _names, callback) => callback(),
      profileServeWait: { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
      rewriteFollowers: async () => undefined,
    });
    expect(fake.writes.some((sql) => sql.startsWith("update runtimes set selected_provider"))).toBe(true);
    expect(fake.writes.some((sql) => sql.startsWith("insert into runtime_model_proven"))).toBe(true);
    expect(fake.writes.some((sql) => sql.startsWith("delete from runtime_model_selection_proofs"))).toBe(true);
  });

  test("a promotion never touches runtime_read_snapshots and always aligns followers", async () => {
    // ohb_worker has no access to that table (0121): an invalidation there threw
    // after every promotion on preprod and skipped the follower alignment.
    const fake = fakeDb({ request_id: "request-a", lease_token: "lease-a", attempts: 1, requested_at: new Date() });
    const { client } = canaryClient();
    let aligned = 0;
    await executeRuntimeModelSelectionProof(fake.db as never, modelJob(), {
      client: () => client,
      withProfileNamesLock: async (_org, _names, callback) => callback(),
      profileServeWait: { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
      rewriteFollowers: async () => { aligned += 1; },
    });
    expect(fake.writes.some((sql) => sql.includes("runtime_read_snapshots"))).toBe(false);
    expect(aligned).toBe(1);
  });

  test("promoted worker log includes named millisecond spans", async () => {
    const fake = fakeDb({ request_id: "request-a", lease_token: "lease-a", attempts: 1, requested_at: new Date() });
    const { client } = canaryClient();
    const log = spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await executeRuntimeModelSelectionProof(fake.db as never, modelJob(), {
        client: () => client,
        withProfileNamesLock: async (_org, _names, callback) => callback(),
        profileServeWait: { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
        rewriteFollowers: async () => undefined,
      });
      const line = log.mock.calls.map(([value]) => String(value)).map((value) => JSON.parse(value) as { event: string; spans?: Record<string, number> })
        .find((entry) => entry.event === "runtime_model_selection.promoted");
      expect(line?.spans).toEqual(expect.objectContaining({
        inventoryMs: expect.any(Number), createProfileMs: expect.any(Number), setModelMs: expect.any(Number),
        isolationMs: expect.any(Number), createRunMs: expect.any(Number), runMs: expect.any(Number),
        cleanupMs: expect.any(Number), totalMs: expect.any(Number),
      }));
    } finally { log.mockRestore(); }
  });

  test("a superseded request clears its lease without promotion", async () => {
    const fake = fakeDb({ request_id: "request-b", lease_token: "lease-a", attempts: 1, requested_at: new Date() });
    const { client } = canaryClient();
    await executeRuntimeModelSelectionProof(fake.db as never, modelJob(), {
      client: () => client,
      withProfileNamesLock: async (_org, _names, callback) => callback(),
      profileServeWait: { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
      rewriteFollowers: async () => undefined,
    });
    expect(fake.writes.some((sql) => sql.startsWith("update runtimes set selected_provider"))).toBe(false);
    expect(fake.writes.some((sql) => sql.includes("set lease_owner = null"))).toBe(true);
  });

  test("cancel then re-request makes the running old lease stale without touching the new proof", async () => {
    const fake = fakeDb({ request_id: "request-b", lease_token: "lease-b", attempts: 1, requested_at: new Date() });
    const { client } = canaryClient();
    await executeRuntimeModelSelectionProof(fake.db as never, modelJob({ request_id: "request-a", lease_token: "lease-a" }), {
      client: () => client,
      withProfileNamesLock: async (_org, _names, callback) => callback(),
      profileServeWait: { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
      rewriteFollowers: async () => undefined,
    });
    expect(fake.writes.some((sql) => sql.startsWith("update runtimes set selected_provider"))).toBe(false);
    expect(fake.writes.some((sql) => sql.startsWith("delete from runtime_model_selection_proofs"))).toBe(false);
    expect(fake.writes.some((sql) => sql.includes("set lease_owner = null"))).toBe(false);
  });

  test("429 queues a retry with exponential backoff and definitive errors do not promote", async () => {
    const busy = new HermesClientError("busy", 429, "HERMES_LIMIT_REACHED");
    const retry = fakeDb({ request_id: "request-a", lease_token: "lease-a", attempts: 1, requested_at: new Date() });
    await executeRuntimeModelSelectionProof(retry.db as never, modelJob(), {
      client: () => canaryClient({ runError: busy }).client,
      withProfileNamesLock: async (_org, _names, callback) => callback(),
      profileServeWait: { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
      rewriteFollowers: async () => undefined,
    });
    expect(retry.writes.some((sql) => sql.includes("status = 'queued'"))).toBe(true);
    expect(retry.writes.some((sql) => sql.startsWith("update runtimes set selected_provider"))).toBe(false);

    const failed = fakeDb({ request_id: "request-a", lease_token: "lease-a", attempts: 1, requested_at: new Date() });
    const { client } = canaryClient({ output: "" });
    await executeRuntimeModelSelectionProof(failed.db as never, modelJob(), {
      client: () => client,
      withProfileNamesLock: async (_org, _names, callback) => callback(),
      profileServeWait: { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
      rewriteFollowers: async () => undefined,
    });
    expect(failed.writes.some((sql) => sql.includes("status = 'failed'"))).toBe(true);
    expect(failed.writes.some((sql) => sql.startsWith("update runtimes set selected_provider"))).toBe(false);
  });

  test("transient profile inventory errors queue a retry instead of failing", async () => {
    const busy = new HermesClientError("busy", 429, "HERMES_LIMIT_REACHED");
    const retry = fakeDb({ request_id: "request-a", lease_token: "lease-a", attempts: 1, requested_at: new Date() });
    const client = { ...canaryClient().client, hostProfileInventory: async () => { throw busy; } } as unknown as HermesClient;
    await executeRuntimeModelSelectionProof(retry.db as never, modelJob({ link_features: ["profile_management"] }), {
      client: () => client,
      withProfileNamesLock: async (_org, _names, callback) => callback(),
      profileServeWait: { timeoutMs: 100, pollMs: 1, sleep: async () => undefined },
      rewriteFollowers: async () => undefined,
    });
    expect(retry.writes.some((sql) => sql.includes("status = 'queued'"))).toBe(true);
    expect(retry.writes.some((sql) => sql.includes("status = 'failed'"))).toBe(false);
  });

  test("the managed check profile is created once, reused, re-applied, and never deleted", async () => {
    const events: string[] = [];
    let present = false;
    const fake = {
      hostProfileInventory: async () => ({ profiles: present ? [{ name: "ohb-model-check" }] : [] }),
      hostCreateProfile: async () => { events.push("profile:create"); present = true; },
      hostSetProfileModel: async () => { events.push("profile:model"); return { applied: true }; },
      probeProfileIsolation: async () => "isolated",
      createRun: async () => { events.push("run:create"); return "run-1"; },
      getRunStatus: async () => ({ status: "completed", output: "OK" }),
      stopRun: async () => undefined,
      deleteSession: async () => { events.push("session:delete"); },
      hostDeleteProfile: async () => { events.push("profile:delete"); },
    } as unknown as HermesClient;
    const lock = async (_org: string, _names: readonly string[], callback: () => Promise<void>) => callback();
    const selection = { provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: null };
    const serveWait = { timeoutMs: 100, pollMs: 1, sleep: async () => undefined };
    await proveManagedRuntimeModelSelection("org-1", () => fake, selection, lock, serveWait);
    await proveManagedRuntimeModelSelection("org-1", () => fake, selection, lock, serveWait);
    expect(events.filter((event) => event === "profile:create")).toHaveLength(1);
    expect(events.filter((event) => event === "profile:model")).toHaveLength(2);
    expect(events).not.toContain("profile:delete");
  });
});
