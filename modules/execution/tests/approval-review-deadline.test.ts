import { describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { reviewGate, type ReviewDeps, type ReviewJob } from "../src/application/approval-review";

const APPROVE = '{"verdict":"approve","reason":"Fits the goal."}';

function job(createdAt: number): ReviewJob {
  return {
    id: "gate-1", organizationId: "org-1", runId: "run-1", botId: null, claimToken: "claim-1",
    createdAt: new Date(createdAt), gateKind: "plugin_tool", toolKey: "write_file",
    gateArgs: { deletes: false, opaque: false, args: { path: "/root/reports/week.md" } },
    command: null, description: "Write the weekly report", goal: "Write the report.",
    workflowId: null, pipeline: "v2", botModel: "bot-model", botReasoningEffort: null,
    assignmentMode: "per_bot", selectedProvider: null, selectedModel: null, selectedReasoningEffort: null,
    runtime: { runtimeId: "rt-1" } as never,
  };
}

/** The writes the reviewer makes; `onLock` runs while the write takes its locks. */
function fakeDb(writes: string[], onLock: () => void = () => undefined): SQL {
  const query = (strings: TemplateStringsArray) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (text.startsWith("update approval_requests")) {
      writes.push(text);
      return Promise.resolve([{ id: "gate-1" }]);
    }
    if (text.includes("from runtime_review_profiles")) return Promise.resolve([{ proven: true }]);
    if (text.includes("from runs") && text.includes("for update")) {
      onLock();
      return Promise.resolve([{ id: "run-1" }]);
    }
    return Promise.resolve([]);
  };
  return Object.assign(query, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(query) }) as unknown as SQL;
}

type Calls = string[];

function client(calls: Calls, getRunStatus: (signal: AbortSignal | undefined) => Promise<unknown>): ReturnType<ReviewDeps["client"]> {
  return {
    mcpInventory: async () => ({ platform: "api_server", servers: [], catalog: [] }) as never,
    hostProfileInventory: async () => ({ profiles: [{ name: "openedbot-reviewer", mcpServers: [] }] }) as never,
    createRun: async () => { calls.push("createRun"); return "hermes-review-1"; },
    getRunStatus: async (_id: string, signal?: AbortSignal) => { calls.push("getRunStatus"); return getRunStatus(signal) as never; },
    stopRun: async () => { calls.push("stopRun"); },
    deleteSession: async () => { calls.push("deleteSession"); },
  };
}

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; logs: Array<Record<string, unknown>> }> {
  const logs: Array<Record<string, unknown>> = [];
  const info = spyOn(console, "info").mockImplementation((line: unknown) => { logs.push(JSON.parse(String(line))); });
  try {
    return { result: await work(), logs };
  } finally {
    info.mockRestore();
  }
}

describe("reviewer budget (PERM2-7)", () => {
  test("a verdict that comes back after the 15 s budget goes to a person, and the review is stopped", async () => {
    const createdAt = 1_000_000;
    const now = { at: createdAt + 14_000 };
    const writes: string[] = [];
    const calls: Calls = [];
    const { logs } = await quietly(() => reviewGate(fakeDb(writes), job(createdAt), {
      now: () => now.at,
      sleep: async (ms) => { now.at += ms; },
      client: () => client(calls, async () => {
        now.at = createdAt + 16_000;
        return { status: "completed", output: APPROVE };
      }),
    }));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("decision_state = 'awaiting_human'");
    expect(calls).toContain("stopRun");
    expect(logs.at(-1)).toMatchObject({ event: "approval.decision", outcome: "human", reason: "review_timeout" });
  });

  test("a verdict read in time but written after the budget is refused under the locks", async () => {
    const createdAt = 2_000_000;
    const now = { at: createdAt + 14_000 };
    const writes: string[] = [];
    const { logs } = await quietly(() => reviewGate(fakeDb(writes, () => { now.at = createdAt + 15_500; }), job(createdAt), {
      now: () => now.at,
      sleep: async (ms) => { now.at += ms; },
      client: () => client([], async () => ({ status: "completed", output: APPROVE })),
    }));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("decision_state = 'awaiting_human'");
    expect(writes[0]).not.toContain("selected_choice");
    expect(logs.at(-1)).toMatchObject({ outcome: "human", reason: "review_timeout" });
  });

  test("the budget aborts a status read still in flight", async () => {
    const writes: string[] = [];
    const calls: Calls = [];
    // Real clock: 60 ms of budget left when the review starts.
    const { logs } = await quietly(() => reviewGate(fakeDb(writes), job(Date.now() - 14_940), {
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
      client: () => client(calls, (signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })),
    }));

    expect(writes[0]).toContain("decision_state = 'awaiting_human'");
    expect(calls).toEqual(["createRun", "getRunStatus", "stopRun", "deleteSession"]);
    expect(logs.at(-1)).toMatchObject({ outcome: "human", reason: "review_timeout" });
  });

  test("the worker's shutdown interrupts the review and hands the gate to a person", async () => {
    const shutdown = new AbortController();
    const writes: string[] = [];
    const calls: Calls = [];
    const { logs } = await quietly(() => reviewGate(fakeDb(writes), job(Date.now()), {
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
      signal: shutdown.signal,
      client: () => client(calls, (signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        shutdown.abort("SIGTERM");
      })),
    }));

    expect(writes[0]).toContain("decision_state = 'awaiting_human'");
    expect(calls).toContain("stopRun");
    expect(logs.at(-1)).toMatchObject({ outcome: "human", reason: "review_failed" });
  });
});
