import { describe, expect, test } from "bun:test";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import type { Entry } from "../../../src/lib/thread/thread-timeline-model";
import {
  createRunLineTracker,
  RUN_ROW_CLOSING_MS,
  runRows,
  runStatusPhase,
  runStatusStep,
  thinkingAgents,
  THINKING_AGENTS_MAX,
} from "../../../src/lib/thread/run-thinking-model";

const tools = (key: string, runId = "r", tool = "terminal", done = true): Entry =>
  ({ kind: "tools", key, runId, calls: [{ tool, done }], approvals: [], targetId: key });
const text = (key: string, value: string, runId = "r"): Entry =>
  ({ kind: "assistant", key, runId, text: value, targetId: key });
const user = (key: string, runId: string | null = "r"): Entry =>
  ({ kind: "user", key, text: "go", runId, steeredIntoActive: false, steeredIntoSettled: false, targetId: key });
const keys = (entries: readonly Entry[]) => entries.map((entry) => entry.key);

describe("runRows", () => {
  test("one row per run with work, after the run's last entry; texts never join it", () => {
    const entries = [user("u"), text("n1", "Je regarde."), tools("t1"), text("n2", "Puis ceci."), tools("t2"), text("a", "Voici.")];
    const row = runRows(entries, { liveRunId: null }).get("r")!;
    expect(keys(row.members)).toEqual(["t1", "t2"]);
    expect(row.after).toBe(5);
    // The panel keeps the sentences written between the tools, not the answer after them.
    expect(keys(row.log)).toEqual(["n1", "t1", "n2", "t2"]);
  });

  test("the live run has a row from its user message on, before any event", () => {
    const rows = runRows([user("u")], { liveRunId: "r" });
    expect(rows.get("r")).toEqual({ members: [], log: [], after: 0, writing: false });
    expect(runRows([user("u")], { liveRunId: null }).size).toBe(0);
  });

  test("writing: the run's last entry is a text", () => {
    expect(runRows([user("u"), tools("t1"), text("a", "Je")], { liveRunId: "r" }).get("r")!.writing).toBe(true);
    expect(runRows([user("u"), text("a", "Je"), tools("t1")], { liveRunId: "r" }).get("r")!.writing).toBe(false);
  });

  test("a run without work keeps a row only when live or closing; a todo-only journal is no work", () => {
    const entries = [user("u"), tools("todo", "r", "todo"), text("a", "Fait.")];
    expect(runRows(entries, { liveRunId: null }).size).toBe(0);
    expect(runRows(entries, { liveRunId: null, closing: new Set(["r"]) }).get("r")!.members).toEqual([]);
  });
});

describe("createRunLineTracker", () => {
  test("a run seen live keeps its bottom row only for its collapse; one never seen live has none", () => {
    const lines = createRunLineTracker();
    expect([...lines.observe("r", 0)]).toEqual([]);
    expect([...lines.observe(null, 100)]).toEqual(["r"]);
    // A second read of the same state (StrictMode) answers the same.
    expect([...lines.observe(null, 150)]).toEqual(["r"]);
    expect([...lines.observe(null, 100 + RUN_ROW_CLOSING_MS)]).toEqual([]);
    expect([...createRunLineTracker().observe(null, 0)]).toEqual([]);
  });

  test("a head line opens only when it appears on a run seen here without one, and once", () => {
    const lines = createRunLineTracker();
    // Opened mid-run, already named: no reveal.
    lines.named("a");
    expect(lines.reveal("a", 0, { summary: false })).toBe(false);
    // A salon run seen live without a head: its summary opens at the end, not on a later remount.
    lines.headless("b");
    expect(lines.reveal("b", 1000, { summary: true })).toBe(true);
    expect(lines.reveal("b", 1100, { summary: true })).toBe(true);
    expect(lines.reveal("b", 5000, { summary: true })).toBe(false);
    // 1:1: the name opened when the first tool started; the summary that replaces it does not.
    lines.headless("c");
    lines.named("c");
    expect(lines.reveal("c", 0, { summary: false })).toBe(true);
    expect(lines.reveal("c", 200, { summary: true })).toBe(false);
  });
});

describe("runStatusPhase", () => {
  test("pending, working, waiting while live; done with work, gone (collapsing) without", () => {
    expect(runStatusPhase({ live: true, pending: true, waiting: false, hasWork: false })).toBe("pending");
    expect(runStatusPhase({ live: true, pending: false, waiting: false, hasWork: false })).toBe("working");
    expect(runStatusPhase({ live: true, pending: false, waiting: true, hasWork: true })).toBe("waiting");
    expect(runStatusPhase({ live: false, pending: false, waiting: false, hasWork: true })).toBe("done");
    expect(runStatusPhase({ live: false, pending: false, waiting: false, hasWork: false })).toBe("gone");
  });
});

describe("runStatusStep", () => {
  const call = (tool: string, done: boolean): ToolCall => ({ tool, done });
  test("a decision first, then the running call, then writing, else thinking", () => {
    expect(runStatusStep([call("terminal", false)], { waiting: true, writing: false })).toEqual({ kind: "waiting" });
    expect(runStatusStep([call("web_search", true), call("terminal", false), call("todo", false)], { waiting: false, writing: true }))
      .toEqual({ kind: "tool", call: call("terminal", false) });
    expect(runStatusStep([call("terminal", true)], { waiting: false, writing: true })).toEqual({ kind: "writing" });
    expect(runStatusStep([], { waiting: false, writing: false })).toEqual({ kind: "thinking" });
  });
});

describe("thinkingAgents", () => {
  const author = { id: "bot-1", name: "Atlas", slug: "atlas", face: null };
  const call = (tool: string, preview?: string): ToolCall => ({ tool, done: false, ...(preview ? { preview } : {}) });

  test("the lead is the run's bot from the start, before any step", () => {
    expect(thinkingAgents(author, [])).toEqual({ visible: [{ id: "bot-1", name: "Atlas", seed: "bot-1", face: null }], overflow: 0 });
    expect(thinkingAgents(null, [])).toEqual({ visible: [], overflow: 0 });
  });

  test("each delegation adds an agent with a stable id; other tools add none", () => {
    const first = thinkingAgents(author, [call("terminal"), call("delegate_task", "Chercheur web"), call("mcp__x__subagent")]);
    expect(first.visible.map((agent) => agent.id)).toEqual(["bot-1", "bot-1:delegate:1", "bot-1:delegate:2"]);
    expect(first.visible[1]!.name).toBe("Chercheur web");
    expect(first.visible[2]!.name).toBe("Atlas 2");
    const later = thinkingAgents(author, [call("terminal"), call("delegate_task", "Chercheur web"), call("mcp__x__subagent"), call("read_file")]);
    expect(later.visible.map((agent) => agent.id)).toEqual(first.visible.map((agent) => agent.id));
  });

  test("past the cap, the rest is counted", () => {
    const many = Array.from({ length: 6 }, () => call("delegate_task"));
    const agents = thinkingAgents(author, many);
    expect(agents.visible).toHaveLength(THINKING_AGENTS_MAX);
    expect(agents.overflow).toBe(7 - THINKING_AGENTS_MAX);
  });
});
