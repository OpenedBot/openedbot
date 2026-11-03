import { describe, expect, test } from "bun:test";
import type { CompactHermes } from "@openedbot/conversation/application/compact-thread";
import { droppedHistoryNotice } from "../../src/application/runner/history";
import { packRoomHistory } from "../../src/application/runner/rooms";

type Row = {
  role: string;
  content: unknown;
  sequence: number;
  authorName: string | null;
  authorSlug: string | null;
};
type Call = { input: string; instructions: string; model: string | null };

const text = (value: string) => [{ type: "text", text: value }];
const ada = { authorName: "Ada", authorSlug: "ada" };
const noAuthor = { authorName: null, authorSlug: null };

/** Les lignes du salon en base : le chargeur de compaction les relit par séquence. */
function fakeDb(state: {
  messages: Row[];
  compaction?: { summary: string; compactedThroughSequence: number; sourceMessageCount: number } | null;
  inserts?: unknown[][];
}): Bun.SQL {
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    if (sql.includes("from thread_compactions")) return Promise.resolve(state.compaction ? [state.compaction] : []);
    if (sql.includes("insert into thread_compactions")) {
      state.inserts?.push(values);
      return Promise.resolve([]);
    }
    if (sql.includes("from messages m")) {
      const after = Number(values[4]);
      const before = values[5] === null ? Infinity : Number(values[5]);
      return Promise.resolve(state.messages.filter((row) => row.sequence > after && row.sequence < before));
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (db as unknown as { begin: (work: (tx: Bun.SQL) => unknown) => unknown }).begin = (work) => work(db);
  return db;
}

function client(output: string | null, calls: Call[]): CompactHermes {
  return {
    ensureSession: async () => undefined,
    createRun: async (body) => {
      calls.push({ input: body.input, instructions: body.instructions ?? "", model: body.model ?? null });
      return "hermes-compact-1";
    },
    getRunStatus: async () => ({
      id: "hermes-compact-1",
      status: output === null ? "failed" : "completed",
      output,
      usage: null,
      pendingSteer: null,
    }),
  };
}

const context = {
  organizationId: "org-1",
  threadId: "thread-1",
  id: "run-1",
  operator: { username: "Camille" },
  model: "gpt-5.6-luna",
  provider: null,
  reasoningEffort: null,
};

const BIG = "o".repeat(40_000);
const KEEP = "k".repeat(8_000);

// Le salon vu par le membre Ada : le message opérateur et le tour d'un autre
// membre arrivent attribués en `user`, ses propres tours en `assistant`.
const dbRows: Row[] = [
  { role: "user", content: text("Decide the budget"), sequence: 1, ...noAuthor },
  { role: "assistant", content: text(BIG), sequence: 2, authorName: "Bob", authorSlug: "bob" },
  { role: "user", content: text(KEEP), sequence: 3, ...noAuthor },
  { role: "assistant", content: text(KEEP), sequence: 4, ...ada },
];
const replayRows = [
  { role: "user", content: "Message from 👤 Camille (@Camille): Decide the budget", sequence: 1 },
  { role: "user", content: `Message from 🤖 Bob (@bob): ${BIG}`, sequence: 2 },
  { role: "user", content: `Message from 👤 Camille (@Camille): ${KEEP}`, sequence: 3 },
  { role: "assistant", content: KEEP, sequence: 4 },
];
const truncation = replayRows.slice(-2).map(({ role, content }) => ({ role, content }));
const turn = {
  history: [{ role: "user", content: droppedHistoryNotice(2) }, ...truncation],
  pack: { rows: replayRows, olderExist: false },
};

describe("packRoomHistory", () => {
  test("sous le budget : le rejeu part tel quel, sans résumé ni appel", async () => {
    const calls: Call[] = [];
    const small = {
      history: [{ role: "user", content: "hello" }],
      pack: { rows: [{ role: "user", content: "hello", sequence: 1 }], olderExist: false },
    };
    const packed = await packRoomHistory(fakeDb({ messages: dbRows }), context, small, {
      client: client("# never", calls),
      signal: new AbortController().signal,
    });
    expect(packed).toEqual({ history: small.history, packInstructions: null });
    expect(calls).toHaveLength(0);
  });

  test("au-dessus du budget : résumé commun en tête, récents gardés, entrée attribuée, modèle du membre", async () => {
    const calls: Call[] = [];
    const inserts: unknown[][] = [];
    const packed = await packRoomHistory(fakeDb({ messages: dbRows, inserts }), context, turn, {
      client: client("# Room state\n- Camille asked, Bob answered", calls),
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("gpt-5.6-luna");
    expect(calls[0]!.instructions).toContain("Room conversation compression");
    expect(calls[0]!.input).toContain("operator Camille: Decide the budget");
    expect(calls[0]!.input).toContain("member Bob (@bob): ");
    expect(inserts).toHaveLength(1);
    expect(packed.packInstructions).toContain("shared by every member");
    expect(packed.history[0]!.content).toContain("# Room state\n- Camille asked, Bob answered");
    expect(packed.history.slice(1)).toEqual(truncation);
  });

  test("résumé prolongé : le précédent part au résumeur, seuls les nouveaux messages sont relus", async () => {
    const calls: Call[] = [];
    const packed = await packRoomHistory(
      fakeDb({
        messages: dbRows,
        compaction: { summary: "# Room state\n- first", compactedThroughSequence: 1, sourceMessageCount: 1 },
      }),
      context,
      turn,
      { client: client("# Room state\n- first and second", calls), signal: new AbortController().signal },
    );
    expect(calls[0]!.input).toContain("# Previous summary\n# Room state\n- first");
    expect(calls[0]!.input).not.toContain("Decide the budget");
    expect(calls[0]!.input).toContain("member Bob (@bob): ");
    expect(packed.history[0]!.content).toContain("first and second");
  });

  test("watermark à jour : le résumé existant est réutilisé sans nouvel appel", async () => {
    const calls: Call[] = [];
    const packed = await packRoomHistory(
      fakeDb({
        messages: dbRows,
        compaction: { summary: "# Room state\n- shared", compactedThroughSequence: 2, sourceMessageCount: 2 },
      }),
      context,
      turn,
      { client: client("# unused", calls), signal: new AbortController().signal },
    );
    expect(calls).toHaveLength(0);
    expect(packed.history[0]!.content).toContain("# Room state\n- shared");
  });

  test("échec du résumeur : la troncature d'avant, rien de persisté", async () => {
    const inserts: unknown[][] = [];
    const packed = await packRoomHistory(fakeDb({ messages: dbRows, inserts }), context, turn, {
      client: client(null, []),
      signal: new AbortController().signal,
    });
    expect(packed).toEqual({ history: turn.history, packInstructions: null });
    expect(inserts).toHaveLength(0);
  });

  test("sans client de compaction : la troncature", async () => {
    const packed = await packRoomHistory(fakeDb({ messages: dbRows }), context, turn);
    expect(packed.history).toBe(turn.history);
    expect(packed.packInstructions).toBeNull();
  });
});
