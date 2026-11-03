import { describe, expect, test } from "bun:test";
import { compactThreadNow, roomSpeakerLabel } from "../src/application/compact-thread";
import type { CompactHermes } from "../src/application/compact-thread";
import {
  buildCompactionInput,
  buildCompactionInstructions,
  buildRoomCompactionInstructions,
  buildRoomPackInstructions,
} from "../src/domain/thread-compaction";

type Row = {
  role: string;
  content: unknown;
  sequence: number;
  authorName: string | null;
  authorSlug: string | null;
};
type Call = { input: string; instructions: string; model: string | null };

const text = (value: string) => [{ type: "text", text: value }];

function fakeDb(state: {
  group: boolean;
  messages: Row[];
  compaction?: { summary: string; compactedThroughSequence: number; sourceMessageCount: number } | null;
  inserts?: unknown[][];
}): Bun.SQL {
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    if (sql.includes("from thread_compactions")) {
      return Promise.resolve(state.compaction ? [state.compaction] : []);
    }
    if (sql.includes("insert into thread_compactions")) {
      state.inserts?.push(values);
      return Promise.resolve([]);
    }
    if (sql.includes("group_id as")) return Promise.resolve([{ groupId: state.group ? "group-1" : null }]);
    if (sql.includes("from messages m")) {
      // Valeurs, dans l'ordre : org, thread, runId x2, afterSequence, beforeSequence x2, newest x3.
      const after = Number(values[4]);
      const before = values[5] === null ? Infinity : Number(values[5]);
      const newest = Number(values[7]);
      const rows = state.messages.filter((row) => row.sequence > after && row.sequence < before);
      return Promise.resolve(newest > 0 ? rows.slice(-newest) : rows.slice(0, 500));
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (db as unknown as { begin: (work: (tx: Bun.SQL) => unknown) => unknown }).begin = (work) => work(db);
  return db;
}

function recordingClient(output: string | null, calls: Call[]): CompactHermes {
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

const ada = { authorName: "Ada", authorSlug: "ada" };
const noAuthor = { authorName: null, authorSlug: null };
const input = {
  organizationId: "org-1",
  threadId: "thread-1",
  model: "gpt-5.6-luna",
  provider: null,
  reasoningEffort: null,
  operatorName: "Camille",
};

describe("attribution de salon", () => {
  test("libellés : opérateur, membre, membre sans slug", () => {
    expect(roomSpeakerLabel({ role: "user", ...noAuthor }, "Camille")).toBe("operator Camille");
    expect(roomSpeakerLabel({ role: "user", ...noAuthor }, null)).toBe("operator");
    expect(roomSpeakerLabel({ role: "assistant", ...ada }, "Camille")).toBe("member Ada (@ada)");
    expect(roomSpeakerLabel({ role: "assistant", ...noAuthor }, null)).toBe("member");
  });

  test("l'entrée du résumeur porte le locuteur, le DM garde le rôle", () => {
    const room = buildCompactionInput({
      date: "2026-10-14",
      previousSummary: "",
      messages: [{ role: "assistant", content: "done", sequence: 1, speaker: "member Ada (@ada)" }],
    });
    expect(room).toContain("member Ada (@ada): done");
    const dm = buildCompactionInput({
      date: "2026-10-14",
      previousSummary: "",
      messages: [{ role: "assistant", content: "done", sequence: 1 }],
    });
    expect(dm).toContain("assistant: done");
  });

  test("consignes de salon : neutres et attribuées, celles des DM inchangées", () => {
    const room = buildRoomCompactionInstructions();
    expect(room).toContain("third person");
    expect(room).toContain("member <name> (@slug)");
    expect(buildCompactionInstructions()).not.toContain("third person");
    expect(buildRoomPackInstructions()).toContain("believe the recent messages");
    expect(buildRoomPackInstructions()).toContain("shared by every member");
  });
});

describe("compactThreadNow", () => {
  const long = "x".repeat(20_000);
  const messages: Row[] = [
    { role: "user", content: text("Plan the launch"), sequence: 1, ...noAuthor },
    { role: "assistant", content: text("Draft ready"), sequence: 2, ...ada },
    { role: "user", content: text(long), sequence: 3, ...noAuthor },
    { role: "assistant", content: text(long), sequence: 4, ...ada },
  ];

  test("plie tout sauf la queue, attribué, et persiste", async () => {
    const inserts: unknown[][] = [];
    const calls: Call[] = [];
    const result = await compactThreadNow(
      fakeDb({ group: true, messages, inserts }),
      recordingClient("# Room state\n- ok", calls),
      input,
      new AbortController().signal,
    );
    expect(result).toEqual({ compacted: true, summarizedCount: 3, compactedThroughSequence: 3 });
    expect(inserts).toHaveLength(1);
    expect(calls[0]!.input).toContain("operator Camille: Plan the launch");
    expect(calls[0]!.input).toContain("member Ada (@ada): Draft ready");
    expect(calls[0]!.instructions).toContain("Room conversation compression");
    expect(calls[0]!.model).toBe("gpt-5.6-luna");
  });

  test("prolonge le résumé existant au lieu de le recalculer", async () => {
    const calls: Call[] = [];
    const result = await compactThreadNow(
      fakeDb({
        group: true,
        messages,
        compaction: { summary: "# Room state\n- before", compactedThroughSequence: 1, sourceMessageCount: 1 },
      }),
      recordingClient("# Room state\n- extended", calls),
      input,
      new AbortController().signal,
    );
    expect(result).toEqual({ compacted: true, summarizedCount: 2, compactedThroughSequence: 3 });
    expect(calls[0]!.input).toContain("# Previous summary\n# Room state\n- before");
    expect(calls[0]!.input).not.toContain("Plan the launch");
  });

  test("résumeur en échec : rien de changé, ne lève pas", async () => {
    const result = await compactThreadNow(
      fakeDb({
        group: true,
        messages,
        compaction: { summary: "s", compactedThroughSequence: 1, sourceMessageCount: 1 },
      }),
      recordingClient(null, []),
      input,
      new AbortController().signal,
    );
    expect(result).toEqual({ compacted: false, summarizedCount: 0, compactedThroughSequence: 1 });
  });

  test("fil court (tout tient dans la queue) ou hors salon : non compacté", async () => {
    const calls: Call[] = [];
    const short = await compactThreadNow(
      fakeDb({ group: true, messages: messages.slice(0, 2) }),
      recordingClient("x", calls),
      input,
      new AbortController().signal,
    );
    expect(short).toEqual({ compacted: false, summarizedCount: 0, compactedThroughSequence: null });
    const dm = await compactThreadNow(
      fakeDb({ group: false, messages }),
      recordingClient("x", calls),
      input,
      new AbortController().signal,
    );
    expect(dm.compacted).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
