import { describe, expect, test } from "bun:test";
import {
  HISTORY_CHAR_BUDGET,
  assemblePackedHistory,
  buildCompactionInput,
  buildCompactionInstructions,
  buildConversationPackInstructions,
  compactionSessionKey,
  historyCharCount,
  normalizeCompactionSummary,
  planConversationPack,
  splitKeepOld,
  takeOldestWithinBudget,
  type HistoryMessage,
} from "../src/domain/thread-compaction";

function msg(sequence: number, content: string, role = "user"): HistoryMessage {
  return { role, content, sequence };
}

describe("splitKeepOld", () => {
  test("tout tient dans KEEP si le fil est court", () => {
    const messages = [msg(1, "a"), msg(2, "b"), msg(3, "c")];
    const { keep, old } = splitKeepOld(messages, 100, 0.4);
    expect(old).toEqual([]);
    expect(keep.map((row) => row.sequence)).toEqual([1, 2, 3]);
  });

  test("KEEP est la queue en caractères, pas en nombre", () => {
    const messages = [
      msg(1, "x".repeat(80)),
      msg(2, "y".repeat(20)),
      msg(3, "z".repeat(20)),
    ];
    const { keep, old } = splitKeepOld(messages, 100, 0.4);
    expect(old.map((row) => row.sequence)).toEqual([1]);
    expect(keep.map((row) => row.sequence)).toEqual([2, 3]);
    expect(historyCharCount(keep)).toBeLessThanOrEqual(40);
  });

  test("un seul message plus gros que KEEP reste", () => {
    const { keep, old } = splitKeepOld([msg(1, "x".repeat(200))], 100, 0.35);
    expect(old).toEqual([]);
    expect(keep).toHaveLength(1);
  });
});

describe("planConversationPack", () => {
  test("sous le budget : pas de compact, pas besoin du résumé", () => {
    const plan = planConversationPack({
      messages: [msg(1, "hello"), msg(2, "world")],
      compaction: null,
    });
    expect(plan.needsCompact).toBe(false);
    expect(plan.old).toEqual([]);
    expect(assemblePackedHistory(plan).map((row) => row.content)).toEqual(["hello", "world"]);
  });

  test("over budget sans watermark : needsCompact", () => {
    // KEEP = 35 % de 100 = 35 → seule la dernière ligne de 20 tient.
    const messages = [
      msg(1, "o".repeat(80)),
      msg(2, "k".repeat(20)),
      msg(3, "k".repeat(20)),
    ];
    const plan = planConversationPack({ messages, compaction: null, budget: 100 });
    expect(plan.needsCompact).toBe(true);
    expect(plan.old.map((row) => row.sequence)).toEqual([1, 2]);
    expect(plan.keep.map((row) => row.sequence)).toEqual([3]);
  });

  test("over budget, watermark à jour : on réutilise le résumé", () => {
    const messages = [
      msg(1, "o".repeat(80)),
      msg(2, "k".repeat(20)),
      msg(3, "k".repeat(20)),
    ];
    const plan = planConversationPack({
      messages,
      compaction: { summary: "# State\n- ok", compactedThroughSequence: 2, sourceMessageCount: 2 },
      budget: 100,
    });
    expect(plan.needsCompact).toBe(false);
    expect(plan.summary).toBe("# State\n- ok");
    const packed = assemblePackedHistory(plan);
    expect(packed[0]?.content).toContain("# State");
    expect(packed[0]?.content).toContain("source of truth");
    expect(packed.slice(1).map((row) => row.content)).toEqual(["k".repeat(20)]);
  });

  test("watermark périmé si OLD a avancé", () => {
    const messages = [
      msg(1, "o".repeat(40)),
      msg(2, "o".repeat(40)),
      msg(3, "k".repeat(20)),
      msg(4, "k".repeat(20)),
    ];
    const plan = planConversationPack({
      messages,
      compaction: { summary: "old", compactedThroughSequence: 1, sourceMessageCount: 1 },
      budget: 100,
    });
    expect(plan.needsCompact).toBe(true);
    expect(plan.old.map((row) => row.sequence)).toEqual([1, 2, 3]);
  });

  test("olderExist sans dépassement de chars force le compact", () => {
    const plan = planConversationPack({
      messages: [msg(1, "hi")],
      compaction: null,
      olderExist: true,
    });
    expect(plan.needsCompact).toBe(true);
  });
});

describe("takeOldestWithinBudget", () => {
  test("plie le préfixe le plus vieux", () => {
    const chunk = takeOldestWithinBudget([
      msg(1, "a".repeat(30)),
      msg(2, "b".repeat(30)),
      msg(3, "c".repeat(30)),
    ], 50);
    expect(chunk.map((row) => row.sequence)).toEqual([1]);
  });
});

describe("prompts", () => {
  test("le résumeur n'autorise pas remember: ni le tool memory", () => {
    const text = buildCompactionInstructions();
    expect(text).toContain("Do not write anything but the summary");
    expect(text).toContain("Do NOT use the runtime `memory` tool");
    expect(text).toContain("# State");
  });

  test("le préfixe bot refuse le fence JSON et l'outil memory du résumeur", () => {
    const text = buildConversationPackInstructions();
    expect(text).not.toContain("remember:");
    expect(text).toContain("Never write a JSON fence");
    expect(text).not.toContain("```memory");
  });

  test("l'entrée du résumeur fusionne le résumé précédent", () => {
    const input = buildCompactionInput({
      date: "2026-08-31",
      previousSummary: "# State\n- prior",
      messages: [msg(1, "hello", "user"), msg(2, "hi", "assistant")],
    });
    expect(input).toContain("Today: 2026-08-31");
    expect(input).toContain("# Previous summary");
    expect(input).toContain("# State\n- prior");
    expect(input).toContain("user: hello");
    expect(input).toContain("assistant: hi");
  });

  test("session de compact isolée par org et fil", () => {
    expect(compactionSessionKey("org", "thread")).toBe("ohb:org:compact:thread:thread");
  });

  test("normalize refuse le vide et borne", () => {
    expect(normalizeCompactionSummary("   ")).toBeNull();
    expect(normalizeCompactionSummary("ok\n")).toBe("ok");
    expect(normalizeCompactionSummary("x".repeat(20_000))?.length).toBe(8_000);
  });
});

describe("HISTORY_CHAR_BUDGET", () => {
  test("le budget reste le proxy 48k", () => {
    expect(HISTORY_CHAR_BUDGET).toBe(48_000);
  });
});
