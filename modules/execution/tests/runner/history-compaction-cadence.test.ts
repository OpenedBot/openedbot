import { describe, expect, test } from "bun:test";
import type { CompactHermes } from "@openedbot/conversation/application/compact-thread";
import { HISTORY_CHAR_BUDGET, type ThreadCompaction } from "@openedbot/conversation/domain/thread-compaction";
import { conversationHistory } from "../../src/application/runner/history";

/**
 * Compaction cadence of a long DM, through the real `conversationHistory`
 * (planner, compaction loader, summarizer call and persistence), turn by turn.
 * Regression guard for the « compaction on every turn » defect: once a thread
 * was over budget, the sliding KEEP window made every run summarize first and
 * rewrote the replayed block, so the provider's prompt cache stopped at the
 * system prompt.
 */

type Row = { role: string; content: Array<{ type: "text"; text: string }>; sequence: number };

function thread(state: { rows: Row[]; compaction: ThreadCompaction | null }): Bun.SQL {
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    if (sql.includes("from message_versions")) return Promise.resolve([]);
    if (sql.includes("from thread_compactions")) return Promise.resolve(state.compaction ? [state.compaction] : []);
    if (sql.includes("insert into thread_compactions")) {
      const next = { summary: String(values[2]), compactedThroughSequence: Number(values[3]), sourceMessageCount: Number(values[4]) };
      if (!state.compaction || state.compaction.compactedThroughSequence <= next.compactedThroughSequence) state.compaction = next;
      return Promise.resolve([]);
    }
    if (sql.includes("limit 201")) return Promise.resolve(state.rows.slice(-201));
    if (sql.includes("limit 500")) {
      const after = Number(values[3]);
      const before = values[4] === null ? Infinity : Number(values[4]);
      return Promise.resolve(state.rows.filter((row) => row.sequence > after && row.sequence < before).slice(0, 500));
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (db as unknown as { begin: (work: (tx: Bun.SQL) => unknown) => unknown }).begin = (work) => work(db);
  return db;
}

function summarizer(counter: { calls: number }): CompactHermes {
  return {
    ensureSession: async () => undefined,
    createRun: async () => {
      counter.calls += 1;
      return `compact-${counter.calls}`;
    },
    // A typical summary: ~1 100 tokens, well under the 8 000-character cap.
    getRunStatus: async (id) => ({
      id,
      status: "completed",
      output: `# State\n- summary ${id}\n${"s".repeat(4_400)}`,
      usage: null,
      pendingSteer: null,
    }),
  };
}

function rowText(text: string): Row["content"] {
  return [{ type: "text", text }];
}

/** Deterministic, realistic sizes: ~120-character questions, 1 200–2 000-character answers. */
async function replay(turns: number, threadId: string) {
  const state = { rows: [] as Row[], compaction: null as ThreadCompaction | null };
  const counter = { calls: 0 };
  const signal = new AbortController().signal;
  const perTurn: Array<{ turn: number; compacted: boolean; prefixStable: boolean | null; replayChars: number }> = [];
  let previous: string[] | null = null;
  for (let turn = 1; turn <= turns; turn += 1) {
    const before = counter.calls;
    const packed = await conversationHistory(
      thread(state),
      { organizationId: "org-cadence", threadId, id: `run-${turn}`, model: null, provider: null, reasoningEffort: null },
      { client: summarizer(counter), signal },
    );
    const replayRows = packed.history.map((row) => `${row.role}\u0000${row.content}`);
    const prefixStable = previous === null ? null : previous.every((row, index) => replayRows[index] === row);
    perTurn.push({
      turn,
      compacted: counter.calls > before,
      prefixStable,
      replayChars: packed.history.reduce((total, row) => total + row.content.length, 0),
    });
    previous = replayRows;
    const sequence = state.rows.length;
    state.rows.push({ role: "user", content: rowText(`Question ${turn}: `.padEnd(120, "u")), sequence: sequence + 1 });
    state.rows.push({ role: "assistant", content: rowText(`Answer ${turn}: `.padEnd(1_200 + ((turn * 337) % 800), "a")), sequence: sequence + 2 });
  }
  return { compactions: counter.calls, perTurn };
}

describe("history compaction cadence (60 turns, real runner)", () => {
  test("compacts about once per half budget of new conversation, never on every turn", async () => {
    const { compactions, perTurn } = await replay(60, "thread-cadence-1");
    const compactedTurns = perTurn.filter((row) => row.compacted).map((row) => row.turn);
    // ~1 760 characters per turn: over budget from turn ~19, then a compaction
    // every ~9 turns (16 000 characters). The previous design compacted on all
    // 42 turns from turn 19 on.
    expect(compactedTurns.length).toBe(compactions);
    expect(compactions).toBeGreaterThanOrEqual(3);
    expect(compactions).toBeLessThanOrEqual(6);
    for (let index = 1; index < compactedTurns.length; index += 1) {
      expect(compactedTurns[index]! - compactedTurns[index - 1]!).toBeGreaterThanOrEqual(8);
    }
  });

  test("the replayed block only grows at its end between two compactions", async () => {
    const { perTurn } = await replay(60, "thread-cadence-2");
    const unstable = perTurn.filter((row) => !row.compacted && row.prefixStable === false);
    expect(unstable).toEqual([]);
    // Bounded: summary (≤ 8 000) + remainder (≤ budget) + the latest exchange.
    for (const row of perTurn) expect(row.replayChars).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET + 8_000 + 2_200);
  });
});
