import { describe, expect, test } from "bun:test";
import {
  COMPACT_RETRY_AFTER_MS,
  COMPACT_RETRY_GROWTH_CHARS,
  HISTORY_CHAR_BUDGET,
  REPLAY_MESSAGE_MAX_CHARS,
  assemblePackedHistory,
  clampReplayedMessages,
  clampReplayedText,
  compactionRetryDue,
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
  type ThreadCompaction,
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
    // KEEP = la moitié de 100 = 50 → les deux dernières lignes de 20 tiennent.
    const messages = [
      msg(1, "o".repeat(80)),
      msg(2, "k".repeat(20)),
      msg(3, "k".repeat(20)),
    ];
    const plan = planConversationPack({ messages, compaction: null, budget: 100 });
    expect(plan.needsCompact).toBe(true);
    expect(plan.old.map((row) => row.sequence)).toEqual([1]);
    expect(plan.keep.map((row) => row.sequence)).toEqual([2, 3]);
    expect(plan.remainderChars).toBe(120);
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

  test("everything after the cut is replayed while it fits the budget, even past the old KEEP window", () => {
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
    expect(plan.needsCompact).toBe(false);
    expect(plan.old).toEqual([]);
    expect(plan.keep.map((row) => row.sequence)).toEqual([2, 3, 4]);
    expect(plan.remainderChars).toBe(80);
  });

  test("the remainder after the cut over budget: fold its oldest part, keep the newest half", () => {
    const messages = [
      msg(1, "o".repeat(40)),
      msg(2, "o".repeat(40)),
      msg(3, "o".repeat(40)),
      msg(4, "k".repeat(20)),
      msg(5, "k".repeat(20)),
    ];
    const plan = planConversationPack({
      messages,
      compaction: { summary: "old", compactedThroughSequence: 1, sourceMessageCount: 1 },
      budget: 100,
    });
    expect(plan.needsCompact).toBe(true);
    expect(plan.old.map((row) => row.sequence)).toEqual([2, 3]);
    expect(plan.keep.map((row) => row.sequence)).toEqual([4, 5]);
  });

  test("a lone oversized message after the cut asks for no compaction it could not shrink", () => {
    const plan = planConversationPack({
      messages: [msg(1, "o".repeat(40)), msg(2, "x".repeat(300))],
      compaction: { summary: "old", compactedThroughSequence: 1, sourceMessageCount: 1 },
      budget: 100,
    });
    expect(plan.needsCompact).toBe(false);
    expect(plan.keep.map((row) => row.sequence)).toEqual([2]);
  });

  test("olderExist with the cut inside the window: the rows above the cap are covered", () => {
    const plan = planConversationPack({
      messages: [msg(10, "a"), msg(11, "b"), msg(12, "c")],
      compaction: { summary: "s", compactedThroughSequence: 10, sourceMessageCount: 10 },
      olderExist: true,
      budget: 100,
    });
    expect(plan.needsCompact).toBe(false);
    expect(plan.keep.map((row) => row.sequence)).toEqual([11, 12]);
  });

  test("olderExist with the cut below the window: compact", () => {
    const plan = planConversationPack({
      messages: [msg(10, "a"), msg(11, "b")],
      compaction: { summary: "s", compactedThroughSequence: 4, sourceMessageCount: 4 },
      olderExist: true,
      budget: 100,
    });
    expect(plan.needsCompact).toBe(true);
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

describe("compaction cadence", () => {
  // A realistic DM: ~120-char questions, 1 200–2 000-char answers.
  function replayTurns(turns: number) {
    const messages: HistoryMessage[] = [];
    let compaction: ThreadCompaction | null = null;
    let compactions = 0;
    let previous: string[] | null = null;
    const results: Array<{ turn: number; compacted: boolean; prefixStable: boolean | null }> = [];
    for (let turn = 1; turn <= turns; turn += 1) {
      const answer = 1_200 + ((turn * 337) % 800);
      messages.push(msg(messages.length + 1, `q${turn} `.padEnd(120, "u"), "user"));
      messages.push(msg(messages.length + 1, `a${turn} `.padEnd(answer, "a"), "assistant"));
      if (historyCharCount(messages) <= HISTORY_CHAR_BUDGET) continue;
      let plan = planConversationPack({ messages, compaction });
      let compacted = false;
      if (plan.needsCompact) {
        compactions += 1;
        compacted = true;
        compaction = {
          summary: `# State\n- summary ${compactions}`.padEnd(4_500, "s"),
          compactedThroughSequence: plan.old[plan.old.length - 1]!.sequence,
          sourceMessageCount: plan.old.length,
        };
        plan = planConversationPack({ messages, compaction });
        expect(plan.needsCompact).toBe(false);
      }
      const replay = assemblePackedHistory(plan).map((row) => `${row.role}:${row.content}`);
      // The previous replay must be an exact prefix of this one unless a compaction moved the cut.
      const prefixStable = previous === null ? null : previous.every((row, index) => replay[index] === row);
      if (!compacted && previous !== null) expect(prefixStable).toBe(true);
      expect(historyCharCount(plan.keep)).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
      results.push({ turn, compacted, prefixStable });
      previous = replay;
    }
    return { compactions, results };
  }

  test("60 turns: one compaction per ~half a budget of conversation, prefix stable in between", () => {
    const { compactions, results } = replayTurns(60);
    // ~1 700 characters per turn and half a budget (16 000) between compactions: ≈ every 9-10 turns.
    expect(compactions).toBeGreaterThan(0);
    expect(compactions).toBeLessThanOrEqual(6);
    const turns = results.map((row) => row.turn).filter((turn, index) => results[index]!.compacted);
    for (let index = 1; index < turns.length; index += 1) {
      expect(turns[index]! - turns[index - 1]!).toBeGreaterThanOrEqual(8);
    }
    expect(results.filter((row) => !row.compacted && row.prefixStable === false)).toEqual([]);
  });
});

describe("clampReplayedText", () => {
  test("short messages stay untouched", () => {
    expect(clampReplayedText("hello", 100)).toBe("hello");
  });

  test("keeps head and tail around a marker, within the bound, deterministically", () => {
    const content = `HEAD${"x".repeat(20_000)}TAIL`;
    const clamped = clampReplayedText(content);
    expect(clamped.length).toBeLessThanOrEqual(REPLAY_MESSAGE_MAX_CHARS);
    expect(clamped.startsWith("HEAD")).toBe(true);
    expect(clamped.endsWith("TAIL")).toBe(true);
    expect(clamped).toMatch(/\[\.\.\. \d+ characters omitted from the middle of this message \.\.\.\]/);
    expect(clampReplayedText(content)).toBe(clamped);
  });

  test("never splits an emoji", () => {
    const clamped = clampReplayedText("😀".repeat(200), 120);
    expect(clamped).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(clamped).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  test("clampReplayedMessages spares the newest message", () => {
    const big = "y".repeat(10_000);
    const out = clampReplayedMessages([msg(1, big), msg(2, big)]);
    expect(out[0]!.content.length).toBeLessThanOrEqual(REPLAY_MESSAGE_MAX_CHARS);
    expect(out[1]!.content).toBe(big);
  });
});

describe("compactionRetryDue", () => {
  test("after a failure, retry only on enough growth or after the delay", () => {
    const failure = { remainderChars: 40_000, at: 1_000 };
    expect(compactionRetryDue(undefined, 40_000, 1_000)).toBe(true);
    expect(compactionRetryDue(failure, 41_700, 2_000)).toBe(false);
    expect(compactionRetryDue(failure, 40_000 + COMPACT_RETRY_GROWTH_CHARS, 2_000)).toBe(true);
    expect(compactionRetryDue(failure, 41_700, 1_000 + COMPACT_RETRY_AFTER_MS)).toBe(true);
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
    expect(compactionSessionKey("org", "thread")).toBe("openedbot:org:compact:thread:thread");
  });

  test("normalize refuse le vide et borne", () => {
    expect(normalizeCompactionSummary("   ")).toBeNull();
    expect(normalizeCompactionSummary("ok\n")).toBe("ok");
    expect(normalizeCompactionSummary("x".repeat(20_000))?.length).toBe(8_000);
  });
});

describe("HISTORY_CHAR_BUDGET", () => {
  test("le budget reste le proxy 32k", () => {
    expect(HISTORY_CHAR_BUDGET).toBe(32_000);
  });
});
