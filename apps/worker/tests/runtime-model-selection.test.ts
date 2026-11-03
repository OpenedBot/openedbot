import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { alignFollowers, withRuntimeModelProofLock } from "../src/maintenance/runtime-model-selection";
import type { ModelProofJob } from "@openedbot/runtimes/application/model-selection-proof";

function job(overrides: Partial<ModelProofJob> = {}): ModelProofJob {
  return {
    runtime_id: "runtime-1", organization_id: "org-1", provider: "anthropic", model: "claude-sonnet-4",
    reasoning_effort: "low", status: "running", request_generation: 1, request_id: "request-1", attempts: 1,
    next_attempt_at: new Date(), error: null, lease_owner: "worker-1", lease_generation: 1, lease_token: "lease-1",
    lease_expires_at: new Date(Date.now() + 240_000), requested_at: new Date(), reachability: "connector",
    endpoint: null, token_ciphertext: null, token_nonce: null, token_tag: null, token_key_id: null,
    edge_auth_ciphertext: null, edge_auth_nonce: null, edge_auth_tag: null, edge_auth_key_id: null, link_features: [],
    ...overrides,
  };
}

describe("runtime model-selection worker", () => {
  test("lock contention requeues the claim without consuming an attempt", async () => {
    const statements: string[] = [];
    let released = false;
    const connection = (async (strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
      statements.push(sql);
      return [{ locked: false }];
    }) as unknown as SQL;
    (connection as unknown as { release(): void }).release = () => { released = true; };
    const db = (async (strings: TemplateStringsArray) => {
      statements.push([...strings].join(" ").replace(/\s+/g, " ").trim());
      return [];
    }) as unknown as SQL;
    (db as unknown as { reserve(): Promise<SQL> }).reserve = async () => connection;
    let ran = false;

    expect(await withRuntimeModelProofLock(db, job(), async () => { ran = true; })).toBe(false);
    expect(ran).toBe(false);
    expect(released).toBe(true);
    expect(statements.some((sql) => sql.includes("attempts = greatest(attempts - 1, 0)") && sql.includes("interval '2 seconds'") && sql.includes("lease_token ="))).toBe(true);
  });

  test("follower alignment skips when the runtime no longer has the job pair", async () => {
    const statements: string[] = [];
    const tx = (async (strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
      statements.push(sql);
      if (sql.includes("from runtimes")) return [{ selectedProvider: "openai", selectedModel: "gpt-4.1" }];
      if (sql.includes("from bots")) return [{ botId: "bot-1", profile: "bot-profile" }];
      return [];
    }) as unknown as SQL;
    (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin = async (callback) => callback(tx as unknown as Bun.TransactionSQL);

    let catalogRead = false;
    await alignFollowers(tx as never, job(), { modelOptions: async () => { catalogRead = true; } } as never);
    expect(statements.some((sql) => sql.includes("from runtimes"))).toBe(true);
    expect(statements.some((sql) => sql.includes("from bots"))).toBe(true);
    expect(catalogRead).toBe(false);
  });
});
