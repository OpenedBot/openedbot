import { describe, expect, test } from "bun:test";
import { cancelledOutputFromEvents } from "../../src/application/runner/cancel";
import { conversationHistory } from "../../src/application/runner/history";
import { persistThreadCompaction, runThreadCompaction } from "@openedbot/conversation/application/compact-thread";
import type { CompactHermes } from "@openedbot/conversation/application/compact-thread";
import { droppedHistoryNotice, interruptedRequestNote } from "../../src/application/runner/history";

type MessageRow = { role: string; content: unknown; sequence: number; interruptedStatus?: "failed" | "cancelled" | null; interruptedTools?: string[] | null };

function text(value: string) {
  return [{ type: "text", text: value }];
}

function fakeDb(state: {
  messages: MessageRow[];
  prefixTruncated?: boolean;
  compaction?: { summary: string; compactedThroughSequence: number; sourceMessageCount: number } | null;
  inserts?: string[];
}): Bun.SQL {
  const db = ((strings: TemplateStringsArray) => {
    const sql = [...strings].join(" ");
    if (sql.includes("from message_versions")) {
      return Promise.resolve(
        state.prefixTruncated ? [{ prefixTruncated: true }] : [],
      );
    }
    if (sql.includes("from thread_compactions") && sql.includes("select")) {
      return Promise.resolve(state.compaction ? [state.compaction] : []);
    }
    if (sql.includes("insert into thread_compactions")) {
      state.inserts?.push(sql);
      return Promise.resolve([]);
    }
    if (sql.includes("limit 201")) {
      return Promise.resolve(state.messages);
    }
    if (sql.includes("limit 500")) {
      const firstKeep = state.messages.length >= 2 ? state.messages[state.messages.length - 2]!.sequence : Infinity;
      return Promise.resolve(state.messages.filter((row) => row.sequence < firstKeep));
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (db as unknown as { begin: (work: (tx: Bun.SQL) => unknown) => unknown }).begin = (work) => work(db);
  return db;
}

const context = {
  organizationId: "org-1",
  threadId: "thread-1",
  id: "run-1",
  model: "gpt-5.6-luna",
  provider: null,
  reasoningEffort: null,
};

const OLD = "o".repeat(40_000);
const KEEP_A = "k".repeat(8_000);
const KEEP_B = "k".repeat(8_000);

const LONG_THREAD: MessageRow[] = [
  { role: "user", content: text(OLD), sequence: 1 },
  { role: "user", content: text(KEEP_A), sequence: 2 },
  { role: "assistant", content: text(KEEP_B), sequence: 3 },
];

function compactClient(output: string | null, status: "completed" | "failed" = "completed"): CompactHermes {
  return {
    ensureSession: async () => undefined,
    createRun: async () => "hermes-compact-1",
    getRunStatus: async () => ({
      id: "hermes-compact-1",
      status,
      output,
      usage: null,
      pendingSteer: null,
    }),
  };
}

describe("conversationHistory interrupted turns", () => {
  test("une demande dont le run a échoué revient, marquée non aboutie", async () => {
    const packed = await conversationHistory(
      fakeDb({
        messages: [
          { role: "user", content: text("Audite les repos DeepSeek"), sequence: 1, interruptedStatus: "failed", interruptedTools: ["skill_view", "web_search"] },
          { role: "user", content: text("Tu es toujours en recherche ?"), sequence: 2, interruptedStatus: null },
        ],
      }),
      context,
    );
    expect(packed.history).toEqual([
      { role: "user", content: `${interruptedRequestNote("failed", ["skill_view", "web_search"])}\nAudite les repos DeepSeek` },
      { role: "user", content: "Tu es toujours en recherche ?" },
    ]);
  });

  test("la note interdit de reprendre seul une demande arrêtée", () => {
    expect(interruptedRequestNote("cancelled")).toContain("stopped before you answered");
    expect(interruptedRequestNote("failed")).toContain("do not redo it on your own unless the user asks for it again");
    // « Tu es toujours en recherche ? » appelle un état, pas une relance.
    expect(interruptedRequestNote("failed")).toContain("say it was interrupted and offer to start it again");
    // Le travail déjà vu dans le fil est nommé, sans prétendre en avoir les résultats.
    expect(interruptedRequestNote("cancelled", ["web_search", "skill_view"]))
      .toContain("already used: web_search, skill_view; their results are not in this history");
    expect(interruptedRequestNote("cancelled")).not.toContain("already used");
  });

  test("la requête ne réintègre que les messages utilisateur non absorbés", async () => {
    let sql = "";
    const db = ((strings: TemplateStringsArray) => {
      const text = [...strings].join(" ");
      if (text.includes("limit 201")) sql = text;
      return Promise.resolve([]);
    }) as unknown as Bun.SQL;
    await conversationHistory(db, context);
    expect(sql).toContain("m.role = 'user'\n             and source_run.status in ('failed', 'cancelled')");
    expect(sql).toContain("coalesce(source_run.completion_kind, '') not in ('steered_into_active', 'folded_into_followup', 'superseded_by_followup')");
  });
});

describe("conversationHistory pack", () => {
  test("fil court : tout part, pas de compact", async () => {
    const packed = await conversationHistory(
      fakeDb({
        messages: [
          { role: "user", content: text("hello"), sequence: 1 },
          { role: "assistant", content: text("hi"), sequence: 2 },
        ],
      }),
      context,
    );
    expect(packed.packInstructions).toBeNull();
    expect(packed.history).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("over budget, watermark à jour : résumé + KEEP, pas de createRun", async () => {
    let created = 0;
    const client: CompactHermes = {
      ...compactClient("# State\n- prior"),
      createRun: async () => {
        created += 1;
        return "unused";
      },
    };
    const packed = await conversationHistory(
      fakeDb({
        messages: LONG_THREAD,
        compaction: { summary: "# State\n- prior", compactedThroughSequence: 1, sourceMessageCount: 1 },
      }),
      { ...context },
      { client, signal: new AbortController().signal },
    );
    expect(created).toBe(0);
    expect(packed.packInstructions).toContain("believe the recent messages");
    expect(packed.history[0]?.content).toContain("# State\n- prior");
    expect(packed.history.slice(1).map((row) => row.content)).toEqual([KEEP_A, KEEP_B]);
  });

  test("compact échoué : aveu droppedHistoryNotice, pas de résumé inventé", async () => {
    const packed = await conversationHistory(
      fakeDb({ messages: LONG_THREAD }),
      context,
      { client: compactClient(null, "failed"), signal: new AbortController().signal },
    );
    expect(packed.packInstructions).toBeNull();
    expect(packed.history[0]?.content).toBe(droppedHistoryNotice(1));
    expect(packed.history[0]?.content).not.toContain("Conversation summary");
  });

  test("compact réussi : persist + résumé en tête", async () => {
    const inserts: string[] = [];
    const packed = await conversationHistory(
      fakeDb({ messages: LONG_THREAD, inserts }),
      context,
      { client: compactClient("# State\n- compact ok"), signal: new AbortController().signal },
    );
    expect(inserts.length).toBeGreaterThan(0);
    expect(packed.packInstructions).toContain("CONVERSATION SUMMARY");
    expect(packed.history[0]?.content).toContain("# State\n- compact ok");
  });
});

describe("cancelled output", () => {
  test("recompose les fragments persistés dans l'ordre", () => {
    expect(cancelledOutputFromEvents([
      { sequence: 3, payload: { text: "monde" } },
      { sequence: 1, payload: { text: "Bonjour " } },
      { sequence: 2, payload: { text: "le " } },
    ], null)).toBe("Bonjour le monde");
  });

  test("retombe sur la sortie terminale si aucun fragment n'a été flushé", () => {
    expect(cancelledOutputFromEvents([], "réponse terminale")).toBe("réponse terminale");
  });
});

describe("runThreadCompaction", () => {
  test("sortie vide : null, aucune écriture", async () => {
    const inserts: string[] = [];
    const db = fakeDb({ messages: [], inserts });
    const result = await runThreadCompaction(
      db,
      compactClient("   "),
      context,
      { previousSummary: "", messages: [{ role: "user", content: "old", sequence: 1 }] },
      new AbortController().signal,
    );
    expect(result).toBeNull();
    expect(inserts).toEqual([]);
  });
});

describe("persistThreadCompaction", () => {
  test("upsert sur (organization_id, thread_id)", async () => {
    const inserts: string[] = [];
    await persistThreadCompaction(
      fakeDb({ messages: [], inserts }),
      "org-1",
      "thread-1",
      { summary: "s", compactedThroughSequence: 4, sourceMessageCount: 2 },
    );
    expect(inserts[0]).toContain("on conflict (organization_id, thread_id)");
  });
});
