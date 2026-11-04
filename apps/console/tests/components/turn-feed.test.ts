import { describe, expect, test } from "bun:test";
import type { Entry } from "../../src/lib/thread/thread-timeline-model";
import { grokSpeaker, readableDetail, turnFeed } from "../../src/components/grok/turn-feed";

type Translate = Parameters<typeof turnFeed>[1];
const t = ((key: string) => key) as unknown as Translate;
const speaker = grokSpeaker({ id: "bot-1", name: "Atlas", slug: "atlas", face: null });

describe("turnFeed: a turn as grok's feed", () => {
  test("what the bot said between two tools is its message, under its face", () => {
    const members: Entry[] = [{ kind: "assistant", key: "a1", text: "Je **lance** le calcul.", runId: "r", targetId: "a1" }];
    expect(turnFeed(members, t, speaker)).toEqual([{ id: "a1", kind: "msg", agent: speaker!, text: "Je lance le calcul." }]);
    // Without a bot (an unknown author), it stays a status line.
    expect(turnFeed(members, t, null)[0]).toMatchObject({ kind: "status" });
  });

  test("a failed tool keeps its error for the panel, never in its label", () => {
    const members: Entry[] = [{
      kind: "tools",
      key: "t1",
      runId: "r",
      targetId: "t1",
      approvals: [],
      calls: [{ tool: "terminal", done: true, failed: true, errorMessage: "Traceback: boom", resultExcerpt: "partial" }],
    }];
    const [item] = turnFeed(members, t, speaker);
    expect(item).toMatchObject({ kind: "tool", failed: true, detail: "Traceback: boom" });
    expect(item!.kind === "tool" && item!.label).not.toContain("Traceback");
  });

  test("a web search carries the pages it found, for the panel to unfold", () => {
    const members: Entry[] = [{
      kind: "search",
      key: "s1",
      runId: "r",
      targetId: "s1",
      trail: { queries: [{ id: "q1", query: "pokemon", resultCount: 1, error: null, sources: [{ title: "Pokémon", url: "https://example.org/a", domain: "example.org", description: null }] }] },
    }];
    expect(turnFeed(members, t, speaker)[0]).toMatchObject({
      kind: "search",
      sources: [{ title: "Pokémon", url: "https://example.org/a", domain: "example.org" }],
    });
  });
});

describe("readableDetail", () => {
  test("a runtime's JSON envelope reads as its output, even cut by the excerpt bound", () => {
    expect(readableDetail('{"output": "Traceback (most recent call last):\\n  File \\"<string>\\"", "exit_code": 1}')).toBe('Traceback (most recent call last):\n  File "<string>"');
    expect(readableDetail('{"output": "ModuleNotFoundError: No module named \'PIL\'\\nexit 1", "hint": "Python cannot imp')).toBe("ModuleNotFoundError: No module named 'PIL'\nexit 1");
  });

  test("plain text, or JSON without output, stays as it came", () => {
    expect(readableDetail("command not found: foo")).toBe("command not found: foo");
    expect(readableDetail('{"status": 1}')).toBe('{"status": 1}');
    expect(readableDetail("   ")).toBeUndefined();
  });

  test("a finished tool's label loses the progress ellipsis", () => {
    const members: Entry[] = [{ kind: "tools", key: "t", runId: "r", targetId: "t", approvals: [], calls: [{ tool: "terminal", done: true }, { tool: "terminal", done: false }] }];
    const fr = ((key: string) => (key === "agentActivity.kindRun" ? "Exécute des commandes…" : key)) as unknown as Translate;
    const [done, live] = turnFeed(members, fr, speaker);
    expect(done).toMatchObject({ label: "Exécute des commandes" });
    expect(live).toMatchObject({ label: "Exécute des commandes…" });
  });
});
