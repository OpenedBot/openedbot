import { describe, expect, test } from "bun:test";
import type { ThreadView } from "../../src/lib/api";
import { mergeThreadHistory, readThreadHistoryHead } from "../../src/lib/thread-history";

function page(id: string, cursor: number, nextBefore: string | null = null): ThreadView {
  const at = "2026-10-05T00:00:00.123456Z";
  return {
    id: "thread", botId: "bot", title: "History", botName: "Bot", instructions: "", model: "", effectiveModel: "",
    createdAt: at, updatedAt: at, approvals: [], cursor, organizationCursor: cursor, truncated: Boolean(nextBefore),
    messages: [{ id: `message-${id}`, sequence: "9007199254740993", role: "user", content: [{ type: "text", text: id }], runId: id, createdAt: at }],
    runs: [{ id, status: "running", input: id, output: null, usage: null, error: null, hermesResponseId: id, runtimeSession: null,
      createdAt: at, startedAt: at, endedAt: null, lastEventAt: at }],
    events: [], workflows: [], history: { nextBefore, hasMore: Boolean(nextBefore), turnKeys: [`run:${id}`] },
  };
}

describe("thread history cache", () => {
  test("late older page retains streamed state and dedupes its active workflow overlap", () => {
    const live = page("active", 120, "older");
    live.runs[0] = { ...live.runs[0]!, status: "completed", output: "Real answer" };
    const event = { cursor: 120, organizationId: "org", threadId: "thread", runId: "active", sequence: 1,
      type: "agent.message" as const, payload: { text: "Live text" }, occurredAt: new Date() };
    live.events = [event];
    live.workflows = [{ id: "workflow", kind: "dm", status: "completed", rootRunId: "active", rootBotId: "bot",
      usedSteps: 2, maxSteps: 10, usedHandoffs: 0, maxHandoffs: 2, usedTokens: 10, tokenBudget: 100,
      deadlineAt: live.createdAt, errorCode: null, errorMessage: null, recoveryState: null, createdAt: live.createdAt, updatedAt: live.updatedAt }];
    const older = page("active", 150, "oldest");
    const archived = page("archive", 2).runs[0]!;
    older.runs.push(archived);
    older.events = [{ ...event, payload: { text: "Stale text" } }];
    older.workflows = [{ ...live.workflows[0]!, status: "running" }];
    const merged = mergeThreadHistory(live, older, "older");
    expect(merged.cursor).toBe(120);
    expect(merged.organizationCursor).toBe(120);
    expect(merged.runs.filter((run) => run.id === "active")).toEqual([live.runs[0]!]);
    expect(merged.runs.find((run) => run.id === "archive")).toBe(archived);
    expect(merged.messages).toHaveLength(1);
    expect(merged.events).toEqual([event]);
    expect(merged.events[0]).toBe(event);
    expect(merged.workflows).toEqual(live.workflows);
    expect(merged.workflows?.[0]).toBe(live.workflows[0]!);
    expect(merged.history?.nextBefore).toBe("oldest");
  });

  test("equal and newer recent reads retain loaded history and its exhausted boundary", () => {
    const loaded = mergeThreadHistory(page("recent", 10, "older"), page("old", 9), "older");
    for (const cursor of [10, 20]) {
      const fresh = page("recent", cursor, "older");
      fresh.runs[0] = { ...fresh.runs[0]!, status: "completed" };
      const merged = mergeThreadHistory(loaded, fresh, "latest");
      expect(merged.runs.map((run) => run.id).sort()).toEqual(["old", "recent"]);
      expect(merged.runs.find((run) => run.id === "old")).toBe(loaded.runs.find((run) => run.id === "old"));
      expect(merged.runs.find((run) => run.id === "recent")?.status).toBe("completed");
      expect(merged.history?.hasMore).toBe(false);
      expect(merged.history?.nextBefore).toBeNull();
    }
  });

  test("older recent read cannot lower the live cursor or replace a terminal run", () => {
    const live = page("recent", 20, "boundary");
    live.runs[0] = { ...live.runs[0]!, status: "failed" };
    const merged = mergeThreadHistory(live, page("recent", 10, "stale"), "latest");
    expect(merged.cursor).toBe(20);
    expect(merged.runs[0]).toBe(live.runs[0]!);
    expect(merged.history?.nextBefore).toBe("boundary");
  });

  test("message ordering preserves bigint precision and run microseconds", () => {
    const recent = page("recent", 20), old = page("old", 10);
    old.messages[0] = { ...old.messages[0]!, sequence: "9007199254740992" };
    old.runs[0] = { ...old.runs[0]!, createdAt: "2026-10-05T00:00:00.123455Z" };
    const merged = mergeThreadHistory(recent, old, "older");
    expect(merged.messages.map((message) => message.id)).toEqual(["message-old", "message-recent"]);
    expect(merged.runs.map((run) => run.id)).toEqual(["old", "recent"]);
  });

  test("reconnect reads missing middle pages before preserving loaded older boundary", async () => {
    const loaded = mergeThreadHistory(page("known", 10, "old"), page("old", 9), "older");
    const requests: Array<string | undefined> = [];
    const pages = [page("new", 30, "middle"), page("middle", 30, "known"), page("known", 30, "old")];
    const head = await readThreadHistoryHead(async (before) => { requests.push(before); return pages.shift()!; }, loaded);
    const merged = mergeThreadHistory(loaded, head, "latest");
    expect(requests).toEqual([undefined, "middle", "known"]);
    expect(merged.runs.map((run) => run.id).sort()).toEqual(["known", "middle", "new", "old"]);
    expect(merged.history?.nextBefore).toBeNull();
  });

  test("a repeating bridge cursor fails rather than looping indefinitely", async () => {
    const loaded = { ...page("known", 10), historyLoaded: true as const };
    await expect(readThreadHistoryHead(async () => page("new", 30, "same"), loaded)).rejects.toThrow("History cursor did not progress");
  });
});
