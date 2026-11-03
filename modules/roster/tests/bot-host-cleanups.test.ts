import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { HermesClientError } from "@openedbot/hermes";
import { executeBotHostCleanup, lockBotHostCleanupForRestore, retryBotHostCleanup, type BotHostCleanupClient } from "../src/application/bot-host-cleanups";
import type { BotHostCleanupRow } from "../src/sql/bot-host-cleanups";

const baseJob: BotHostCleanupRow = {
  id: "cleanup-1", organization_id: "org-1", bot_id: "bot-1", runtime_id: "runtime-1",
  profile: "scout", session_profile: "scout", session_ids: [], verify_session_ids: [], verify_passes: 0, status: "running", attempts: 0,
  lease_owner: "worker-1", lease_generation: 4, lease_expires_at: new Date(Date.now() + 60_000),
};

function scriptedDb(options: { lease?: boolean[]; finish?: boolean } = {}) {
  const leases = [...(options.lease ?? [true, true, true, true, true])];
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...parts].join(" ");
    statements.push({ sql, values });
    if (sql.includes("set lease_expires_at")) return Promise.resolve(leases.shift() ? [{ id: baseJob.id }] : []);
    if (sql.includes("array_remove")) return Promise.resolve([{ id: baseJob.id }]);
    return Promise.resolve(options.finish === false ? [] : [{ id: baseJob.id }]);
  }) as unknown as SQL;
  return { db, statements };
}

function client(options: { inventory?: boolean[]; deleteError?: boolean; present?: boolean[] } = {}) {
  const calls: string[] = [];
  const reads = [...(options.inventory ?? [true, false])];
  const present = [...(options.present ?? [])];
  const host: BotHostCleanupClient = {
    removeSession: async (id) => {
      calls.push(`session:${id}`);
      if (options.deleteError) throw new HermesClientError("secret upstream body", 503, "HERMES_UNREACHABLE");
      return present.shift() ?? true;
    },
    hostProfileInventory: async () => {
      calls.push("inventory");
      return { profiles: reads.shift() ? [{ name: "scout" }] as never[] : [] } as never;
    },
    hostDeleteProfile: async (slug) => { calls.push(`profile:${slug}`); },
  };
  return { host, calls };
}

describe("bot host cleanup", () => {
  test("only succeeds after the profile is absent from the fresh inventory", async () => {
    const { db, statements } = scriptedDb();
    const fake = client({ inventory: [true, false] });
    await executeBotHostCleanup(db, baseJob, { client: () => fake.host });
    expect(fake.calls).toEqual(["inventory", "profile:scout", "inventory"]);
    expect(statements.at(-1)?.values).toContain("succeeded");
  });

  test("retries a profile still listed and fails on attempt ten", async () => {
    const { db, statements } = scriptedDb();
    const fake = client({ inventory: [true, true] });
    await executeBotHostCleanup(db, { ...baseJob, attempts: 9 }, { client: () => fake.host });
    expect(fake.calls).toEqual(["inventory", "profile:scout", "inventory"]);
    expect(statements.at(-1)?.values).toContain("failed");
    expect(JSON.stringify(statements.at(-1)?.values)).toContain("BOT_HOST_CLEANUP_FAILED");
  });

  test("a lost lease stops before the next host call", async () => {
    const { db } = scriptedDb({ lease: [true, false] });
    const fake = client();
    await executeBotHostCleanup(db, { ...baseJob, profile: null, session_ids: ["one", "two"] }, { client: () => fake.host });
    expect(fake.calls).toEqual(["session:one"]);
  });

  test("records a deleted session before retry so it is not replayed", async () => {
    const { db, statements } = scriptedDb();
    const fake = client();
    await executeBotHostCleanup(db, { ...baseJob, profile: null, session_ids: ["one"] }, { client: () => fake.host });
    expect(fake.calls).toEqual(["session:one"]);
    expect(statements.some((statement) => statement.sql.includes("array_remove") && statement.values.includes("one"))).toBe(true);
  });

  test("records the proof that the profile is gone before scheduling a verification (0150)", async () => {
    const { db, statements } = scriptedDb();
    const fake = client({ inventory: [true, false] });
    await executeBotHostCleanup(db, { ...baseJob, session_ids: ["t-1:greeting"] }, { client: () => fake.host });
    const recorded = statements.findIndex((statement) => statement.sql.includes("set profile_removed_at = now()"));
    expect(recorded).toBeGreaterThan(-1);
    expect(statements.slice(recorded + 1).some((statement) => statement.sql.includes("verify_passes ="))).toBe(true);
  });

  test("a profile never created is proven absent without a delete", async () => {
    const { db, statements } = scriptedDb();
    const fake = client({ inventory: [false] });
    await executeBotHostCleanup(db, baseJob, { client: () => fake.host });
    expect(fake.calls).toEqual(["inventory"]);
    expect(statements.some((statement) => statement.sql.includes("set profile_removed_at = now()"))).toBe(true);
  });

  test("a verification pass never touches a name already proven gone: a new bot may own it", async () => {
    const { db } = scriptedDb();
    const fake = client({ inventory: [true], present: [false] });
    await executeBotHostCleanup(db, { ...baseJob, verify_session_ids: ["t-1:greeting"], profile_removed_at: new Date() }, { client: () => fake.host });
    expect(fake.calls).toEqual(["session:t-1:greeting"]);
  });

  test("a lost lease while recording the proof stops the pass", async () => {
    const { db, statements } = scriptedDb({ finish: false });
    const fake = client({ inventory: [false] });
    await executeBotHostCleanup(db, baseJob, { client: () => fake.host });
    expect(statements.at(-1)?.sql).toContain("set profile_removed_at = now()");
  });

  describe("post-mortem verification (DEV-OHB-244)", () => {
    test("a pass that deleted surviving sessions waits before succeeding", async () => {
      const { db, statements } = scriptedDb();
      const fake = client();
      await executeBotHostCleanup(db, { ...baseJob, profile: null, session_ids: ["one"] }, { client: () => fake.host });
      const last = statements.at(-1)!;
      expect(last.sql).toContain("verify_passes =");
      expect(last.sql).toContain("next_attempt_at = now() +");
      expect(last.values).not.toContain("succeeded");
    });

    test("only the greeting session outlives an owned profile and is verified", async () => {
      const { db, statements } = scriptedDb();
      const fake = client({ inventory: [true, false] });
      await executeBotHostCleanup(db, { ...baseJob, session_ids: ["t-1", "t-1:greeting"] }, { client: () => fake.host });
      const appended = statements.filter((statement) => statement.sql.includes("array_append")).map((statement) => statement.values[1]);
      expect(appended).toEqual([false, true]);
      expect(statements.at(-1)?.sql).toContain("verify_passes =");
    });

    test("succeeds once one pass finds every verified session absent", async () => {
      const { db, statements } = scriptedDb();
      const fake = client({ present: [false] });
      await executeBotHostCleanup(db, { ...baseJob, profile: null, verify_session_ids: ["one"] }, { client: () => fake.host });
      expect(fake.calls).toEqual(["session:one"]);
      expect(statements.at(-1)?.values).toContain("succeeded");
      expect(statements.at(-1)?.sql).toContain("verify_session_ids = case");
    });

    test("keeps a session found absent listed while another came back (staggered resurrection)", async () => {
      const { db, statements } = scriptedDb();
      const fake = client({ present: [false, true] });
      await executeBotHostCleanup(db, { ...baseJob, profile: null, verify_session_ids: ["a", "b"], verify_passes: 1 }, { client: () => fake.host });
      expect(fake.calls).toEqual(["session:a", "session:b"]);
      expect(statements.some((statement) => statement.sql.includes("array_remove(verify_session_ids"))).toBe(false);
      expect(statements.at(-1)?.sql).toContain("verify_passes =");
      // The next pass re-reads both, so "a" coming back is caught.
      const next = scriptedDb();
      const again = client({ present: [true, false] });
      await executeBotHostCleanup(next.db, { ...baseJob, profile: null, verify_session_ids: ["a", "b"], verify_passes: 2 }, { client: () => again.host });
      expect(again.calls).toEqual(["session:a", "session:b"]);
      expect(next.statements.at(-1)?.values).not.toContain("succeeded");
    });

    test("a resurrected session is deleted again and re-checked later", async () => {
      const { db, statements } = scriptedDb();
      const fake = client({ present: [true] });
      await executeBotHostCleanup(db, { ...baseJob, profile: null, verify_session_ids: ["one"], verify_passes: 1 }, { client: () => fake.host });
      expect(fake.calls).toEqual(["session:one"]);
      expect(statements.at(-1)?.sql).toContain("verify_passes =");
      expect(statements.at(-1)?.values).toContain(2);
    });

    test("gives up into the ordinary retry path after the last verification pass", async () => {
      const { db, statements } = scriptedDb();
      const fake = client({ present: [true] });
      await executeBotHostCleanup(db, { ...baseJob, profile: null, verify_session_ids: ["one"], verify_passes: 4 }, { client: () => fake.host });
      expect(statements.at(-1)?.values).toContain("queued");
      expect(statements.at(-1)?.sql).toContain("attempts = case");
    });
  });

  test("deletes the early greeting session on the default profile (DEV-OHB-244)", async () => {
    const { db } = scriptedDb();
    const fake = client();
    const profiles: Array<string | null> = [];
    await executeBotHostCleanup(db, { ...baseJob, profile: null, session_ids: ["ohb:org-1:t-1", "ohb:org-1:t-1:greeting"] }, {
      client: (_runtimeId, profile) => { profiles.push(profile); return fake.host; },
    });
    expect(fake.calls).toEqual(["session:ohb:org-1:t-1", "session:ohb:org-1:t-1:greeting"]);
    expect(profiles).toEqual(["scout", null]);
  });

  test("never deletes a profile the bot does not own", async () => {
    const { db } = scriptedDb();
    const fake = client();
    await executeBotHostCleanup(db, { ...baseJob, profile: null }, { client: () => fake.host });
    expect(fake.calls).toEqual([]);
  });

  test("restore cancels queued work and refuses a live cleanup lease", async () => {
    const run = async (status: string, live: boolean) => {
      const statements: string[] = [];
      const tx = ((parts: TemplateStringsArray) => {
        const sql = [...parts].join(" ");
        statements.push(sql);
        return Promise.resolve(sql.includes("for update") ? [{ id: "cleanup-1", status, live }] : []);
      }) as unknown as SQL;
      (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
      return { result: await lockBotHostCleanupForRestore(tx as never, "org-1", "bot-1"), statements };
    };
    const queued = await run("queued", false);
    expect(queued.result).toBe("queued-cancelled");
    expect(queued.statements.some((sql) => sql.includes("set status = 'cancelled'"))).toBe(true);
    expect((await run("running", true)).result).toBe("running");
  });

  test("restore refuses re-trash while its new running job coexists with cancelled history", async () => {
    const statements: string[] = [];
    const historicalJobs = [
      { id: "cleanup-old", status: "cancelled", live: false },
      { id: "cleanup-current", status: "running", live: true },
    ];
    const tx = ((parts: TemplateStringsArray) => {
      const sql = [...parts].join(" ");
      statements.push(sql);
      return Promise.resolve(sql.includes("for update")
        ? historicalJobs.filter((job) => ["queued", "running", "failed"].includes(job.status)).slice(-1)
        : []);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
    const result = await lockBotHostCleanupForRestore(tx as never, "org-1", "bot-1");
    expect(result).toBe("running");
    const lock = statements.find((sql) => sql.includes("for update"))!;
    expect(lock).toContain("status in ('queued','running','failed')");
    expect(lock).toContain("order by created_at desc, id desc limit 1");
  });

  test("retry is allowed only from failed", async () => {
    const statements: string[] = [];
    const tx = ((parts: TemplateStringsArray) => {
      const sql = [...parts].join(" ");
      statements.push(sql);
      if (sql.includes("update bot_host_cleanups")) return Promise.resolve([]);
      return Promise.resolve([{ status: "queued" }]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
    await expect(retryBotHostCleanup(tx as never, "org-1", "bot-1")).rejects.toMatchObject({ status: 409, code: "BOT_HOST_CLEANUP_NOT_FAILED" });
    expect(statements.find((sql) => sql.includes("update bot_host_cleanups"))).toContain("status = 'failed'");
  });

  test("retry requeues a failed cleanup even after its bot was purged", async () => {
    const statements: string[] = [];
    const tx = ((parts: TemplateStringsArray) => {
      const sql = [...parts].join(" ");
      statements.push(sql);
      if (sql.includes("update bot_host_cleanups")) return Promise.resolve([{ id: "cleanup-1" }]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin = async (callback) => callback(tx);
    expect(await retryBotHostCleanup(tx as never, "org-1", "bot-1")).toBeNull();
    expect(statements.some((sql) => sql.includes("attempts = 0"))).toBe(true);
  });
});
