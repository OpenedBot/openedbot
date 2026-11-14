import { describe, expect, test } from "bun:test";
import {
  approvalWaitMs,
  groupToolCalls,
  parseToolResult,
  readAttachment,
  readToolOutcome,
  TOOL_LOG_MAX_LINES,
  toolFailureSummary,
  toolGroupLog,
  toolGroupLogText,
  toolGroupStatus,
  toolInputLanguage,
  toolKind,
  toolService,
} from "../src/domain/thread-tools";

describe("groupToolCalls : échecs comptés", () => {
  test("un groupe replié compte ses échecs et garde leurs messages", () => {
    const [group] = groupToolCalls([
      { tool: "skill_manage", done: true, failed: true, errorMessage: "skill exists" },
      { tool: "skill_manage", done: true, durationMs: 12 },
    ]);
    expect(group).toEqual({
      tool: "skill_manage",
      count: 2,
      done: true,
      failed: true,
      failures: 1,
      errorMessages: ["skill exists"],
      durationMs: 12,
      calls: [
        { tool: "skill_manage", done: true, failed: true, errorMessage: "skill exists" },
        { tool: "skill_manage", done: true, durationMs: 12 },
      ],
    });
    expect(toolGroupStatus(group!)).toBe("partial");
  });

  test("un groupe replié conserve l'extrait de chaque appel", () => {
    const [group] = groupToolCalls([
      { tool: "skill_view", done: true, preview: "symfony" },
      { tool: "skill_view", done: true, preview: "php-architecture" },
    ]);
    expect(group?.count).toBe(2);
    expect(group?.preview).toBeUndefined();
    expect(group?.previews).toEqual(["symfony", "php-architecture"]);
    expect(group?.calls).toHaveLength(2);
  });

  test("sans message d'erreur, aucune clé `errorMessages` n'apparaît", () => {
    const [group] = groupToolCalls([{ tool: "terminal", done: true, failed: true }]);
    expect(group).toEqual({
      tool: "terminal",
      count: 1,
      done: true,
      failed: true,
      failures: 1,
      calls: [{ tool: "terminal", done: true, failed: true }],
    });
    expect(toolGroupStatus(group!)).toBe("failed");
  });

  test("un groupe conserve les détails individuels quand il replie des appels attachés", () => {
    const [group] = groupToolCalls([
      { tool: "terminal", done: true, attachment: { input: "pwd", result: "/tmp" } },
      { tool: "terminal", done: true, attachment: { input: "ls", result: "file.txt" } },
    ]);
    expect(group?.count).toBe(2);
    expect(group?.attachment).toBeUndefined();
    expect(group?.calls.map((call) => call.attachment)).toEqual([
      { input: "pwd", result: "/tmp" },
      { input: "ls", result: "file.txt" },
    ]);
  });

  test("statut : tout réussi = done, en cours = running", () => {
    expect(toolGroupStatus({ count: 3, done: true })).toBe("done");
    expect(toolGroupStatus({ count: 3, done: false })).toBe("running");
    // `failed` sans `failures` (source ancienne) : tout le groupe est en échec.
    expect(toolGroupStatus({ count: 2, done: true, failed: true })).toBe("failed");
  });
});

describe("readToolOutcome", () => {
  test("lit le message d'erreur borné du payload, null sinon", () => {
    expect(readToolOutcome({ error: true, durationMs: 27, errorMessage: "skill exists" })).toEqual({
      failed: true, durationMs: 27, errorMessage: "skill exists",
    });
    expect(readToolOutcome({ error: true, durationMs: 27, errorMessage: null })).toEqual({
      failed: true, durationMs: 27, errorMessage: null,
    });
    expect(readToolOutcome({ error: false })).toEqual({ failed: false, durationMs: null, errorMessage: null });
  });

  test("reads the live result excerpt, and leaves it out when blank", () => {
    expect(readToolOutcome({ error: false, durationMs: 4, resultExcerpt: "ok\n" })).toEqual({
      failed: false, durationMs: 4, errorMessage: null, resultExcerpt: "ok\n",
    });
    expect(readToolOutcome({ error: false, resultExcerpt: "   " })).toEqual({ failed: false, durationMs: null, errorMessage: null });
    expect(readToolOutcome({ error: false, resultExcerpt: null })).toEqual({ failed: false, durationMs: null, errorMessage: null });
  });
});

describe("toolKind", () => {
  test("names the family of known tools, MCP prefix stripped", () => {
    expect(toolKind("terminal")).toBe("run");
    expect(toolKind("web_search")).toBe("search");
    expect(toolKind("web_extract")).toBe("web");
    expect(toolKind("browser_navigate")).toBe("web");
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("write_file")).toBe("edit");
    expect(toolKind("execute_code")).toBe("code");
    expect(toolKind("delegate_task")).toBe("delegate");
    expect(toolKind("mcp__files__read_file")).toBe("read");
  });

  test("an unknown tool is other, an unknown MCP tool keeps its service", () => {
    expect(toolKind("skill_manage")).toBe("other");
    expect(toolKind("constructor")).toBe("other");
    expect(toolKind("mcp__notion__create_page")).toBe("mcp");
    expect(toolService("mcp__notion__create_page")).toBe("notion");
    expect(toolService("terminal")).toBeNull();
  });
});

describe("toolGroupLog", () => {
  test("a running shell call shows its command only", () => {
    expect(toolGroupLog({ tool: "terminal", calls: [{ tool: "terminal", done: false, preview: "bun test" }] }, "fr")).toEqual([
      { text: "$ bun test", tone: "command" },
    ]);
  });

  test("the live excerpt follows the command, the attached result replaces it", () => {
    const live = toolGroupLog({
      tool: "terminal",
      calls: [{ tool: "terminal", done: true, preview: "ls", resultExcerpt: '{"output": "a.txt\\nb.txt", "exit_code": 0}' }],
    }, "fr");
    expect(live).toEqual([
      { text: "$ ls", tone: "command" },
      { text: "a.txt", tone: "output" },
      { text: "b.txt", tone: "output" },
    ]);
    const attached = toolGroupLog({
      tool: "terminal",
      calls: [{ tool: "terminal", done: true, preview: "ls", resultExcerpt: "a.txt", attachment: { result: "a.txt\nb.txt\nc.txt" } }],
    }, "fr");
    expect(attached.map((line) => line.text)).toEqual(["$ ls", "a.txt", "b.txt", "c.txt"]);
  });

  test("calls of a group are separated, errors are marked, silent calls add nothing", () => {
    const lines = toolGroupLog({
      tool: "terminal",
      calls: [
        { tool: "terminal", done: true, preview: "pwd", resultExcerpt: "/tmp" },
        { tool: "terminal", done: true },
        { tool: "terminal", done: true, failed: true, preview: "foo", errorMessage: "command not found: foo" },
      ],
    }, "fr");
    expect(lines).toEqual([
      { text: "$ pwd", tone: "command" },
      { text: "/tmp", tone: "output" },
      { text: "", tone: "note" },
      { text: "$ foo", tone: "command" },
      { text: "command not found: foo", tone: "error" },
    ]);
    expect(toolGroupLogText({ tool: "terminal", calls: [{ tool: "terminal", done: true, preview: "pwd", resultExcerpt: "/tmp" }] }, "fr"))
      .toBe("$ pwd\n/tmp");
  });

  test("a non-shell tool shows its preview without a prompt, and nothing when silent", () => {
    expect(toolGroupLog({ tool: "read_file", calls: [{ tool: "read_file", done: false, preview: "src/app.ts" }] }, "fr"))
      .toEqual([{ text: "src/app.ts", tone: "command" }]);
    expect(toolGroupLog({ tool: "skill_manage", calls: [{ tool: "skill_manage", done: true }] }, "fr")).toEqual([]);
  });

  test("an ambiguous attachment never lends a result to the call", () => {
    expect(toolGroupLog({ tool: "terminal", calls: [{ tool: "terminal", done: true, preview: "id", attachment: { ambiguous: true } }] }, "fr"))
      .toEqual([{ text: "$ id", tone: "command" }]);
  });

  test("a huge output keeps its head and its tail within the budget, and says how many lines it hid", () => {
    const total = TOOL_LOG_MAX_LINES + 50;
    const result = Array.from({ length: total }, (_, index) => `line ${index}`).join("\n");
    const group = {
      tool: "terminal",
      calls: [{ tool: "terminal", done: true, failed: true, preview: "bun test", attachment: { result }, errorMessage: "exit status 1" }],
    };
    const lines = toolGroupLog(group, "fr");
    expect(lines).toHaveLength(TOOL_LOG_MAX_LINES);
    // 1 command + 450 output lines + 1 error = 452; 399 shown, 1 marker.
    const hidden = total + 2 - (TOOL_LOG_MAX_LINES - 1);
    const marker = lines.find((line) => line.hidden !== undefined)!;
    expect(marker).toEqual({ text: `${hidden} lignes masquées`, tone: "note", hidden });
    expect(lines[0]).toEqual({ text: "$ bun test", tone: "command" });
    expect(lines[1]).toEqual({ text: "line 0", tone: "output" });
    // The end of the log, where errors usually are, is never the part cut.
    expect(lines.at(-1)).toEqual({ text: "exit status 1", tone: "error" });
    expect(lines.at(-2)).toEqual({ text: `line ${total - 1}`, tone: "output" });
    const markerIndex = lines.indexOf(marker);
    expect(lines.slice(0, markerIndex)).toHaveLength(Math.floor((TOOL_LOG_MAX_LINES - 1) / 2));
    expect(toolGroupLog(group, "en").find((line) => line.hidden !== undefined)?.text).toBe(`${hidden} lines hidden`);
  });

  test("the copied text is the whole log, not the shown excerpt", () => {
    const result = Array.from({ length: TOOL_LOG_MAX_LINES + 50 }, (_, index) => `line ${index}`).join("\n");
    const text = toolGroupLogText({ tool: "terminal", calls: [{ tool: "terminal", done: true, preview: "seq", attachment: { result } }] }, "fr");
    expect(text).toBe(`$ seq\n${result}`);
  });

  test("a log within the budget has no marker", () => {
    const result = Array.from({ length: TOOL_LOG_MAX_LINES }, (_, index) => `line ${index}`).join("\n");
    const lines = toolGroupLog({ tool: "terminal", calls: [{ tool: "terminal", done: true, attachment: { result } }] }, "fr");
    expect(lines).toHaveLength(TOOL_LOG_MAX_LINES);
    expect(lines.some((line) => line.hidden !== undefined)).toBe(false);
  });

  test("a live excerpt cut by the worker's cap still reads as lines, then says it was truncated", () => {
    // What `sanitizeToolErrorMessage` stores for a long `terminal` result:
    // 499 characters of the JSON text, then "…".
    const json = JSON.stringify({ output: Array.from({ length: 80 }, (_, index) => `line ${index}\tok "q" é`).join("\n"), exit_code: 0 })
      .replace("é", "\\u00e9");
    const excerpt = `${json.slice(0, 499)}…`;
    expect(() => JSON.parse(excerpt)).toThrow();
    const lines = toolGroupLog({ tool: "terminal", calls: [{ tool: "terminal", done: true, preview: "seq", resultExcerpt: excerpt }] }, "en");
    expect(lines[0]).toEqual({ text: "$ seq", tone: "command" });
    expect(lines[1]).toEqual({ text: 'line 0\tok "q" é', tone: "output" });
    const outputs = lines.filter((line) => line.tone === "output");
    expect(outputs.length).toBeGreaterThan(10);
    expect(outputs.every((line) => !line.text.includes("\\n") && !line.text.includes("…"))).toBe(true);
    expect(lines.at(-1)).toEqual({ text: "result truncated", tone: "note" });
  });

  test("a cut in the middle of an escape drops the partial escape", () => {
    const lines = toolGroupLog({ tool: "terminal", calls: [{ tool: "terminal", done: true, resultExcerpt: '{"output": "a\\nb\\u00…' }] }, "fr");
    expect(lines).toEqual([
      { text: "a", tone: "output" },
      { text: "b", tone: "output" },
      { text: "résultat tronqué", tone: "note" },
    ]);
  });

  test("an empty output with an error shows the error, not the raw JSON", () => {
    const lines = toolGroupLog({
      tool: "terminal",
      calls: [{ tool: "terminal", done: true, failed: true, preview: "false", resultExcerpt: '{"output":"","exit_code":1,"error":"x"}', errorMessage: "x" }],
    }, "fr");
    expect(lines).toEqual([
      { text: "$ false", tone: "command" },
      { text: "x", tone: "error" },
    ]);
    expect(toolGroupLog({ tool: "terminal", calls: [{ tool: "terminal", done: true, resultExcerpt: '{"output": "", "exit_code": 0}' }] }, "fr"))
      .toEqual([]);
  });

  test("a non-JSON or non-output excerpt is shown as sent", () => {
    expect(toolGroupLog({ tool: "terminal", calls: [{ tool: "terminal", done: true, resultExcerpt: '{"status": "ok"' }] }, "fr"))
      .toEqual([{ text: '{"status": "ok"', tone: "output" }]);
  });
});

describe("tool detail helpers", () => {
  test("reads full attachment fields and falls back to no attachment when empty", () => {
    expect(readAttachment({ input: "print(1)", result: "1", errorMessage: "failed", exitCode: 1, status: "error", truncated: true })).toEqual({
      input: "print(1)", result: "1", errorMessage: "failed", exitCode: 1, status: "error", truncated: true,
    });
    expect(readAttachment({ input: "print(1)" })).toEqual({ input: "print(1)" });
    expect(readAttachment({})).toBeNull();
  });

  test("chooses a code language from the tool and file extension", () => {
    expect(toolInputLanguage("execute_code", "print(1)")).toBe("python");
    expect(toolInputLanguage("terminal", "ls")).toBe("bash");
    expect(toolInputLanguage("write_file", "src/example.ts\nexport const value = 1")).toBe("typescript");
    expect(toolInputLanguage("search", "{\"query\":\"docs\"}")).toBe("json");
    expect(toolInputLanguage("search", "plain query")).toBe("text");
  });

  test("parses code and terminal results, web extraction errors, and ignores non-JSON", () => {
    expect(parseToolResult("execute_code", '{"status":"error","output":"","exit_code":1,"error":"kernel missing","duration_seconds":2,"tool_calls_made":3}')).toEqual({
      status: "error", output: "", error: "kernel missing", exitCode: 1, durationSeconds: 2, toolCallsMade: 3,
    });
    expect(parseToolResult("terminal", '{"status":"error","output":"bad","exit_code":127}')).toEqual({
      status: "error", output: "bad", exitCode: 127,
    });
    expect(parseToolResult("web_extract", '{"results":[{"url":"https://example.com","title":"Page","error":"blocked"}]}')).toEqual({
      webResults: [{ url: "https://example.com", title: "Page", error: "blocked" }],
    });
    expect(parseToolResult("terminal", "not json")).toBeNull();
  });

  test("summarizes only the first error line and caps the visible label", () => {
    expect(toolFailureSummary({ errorMessages: ["command failed\nsecond line"] })).toBe("command failed");
    expect(toolFailureSummary({ errorMessages: ["x".repeat(100)] })).toBe(`${"x".repeat(77)}...`);
    expect(toolFailureSummary({ errorMessages: [] })).toBeNull();
  });

  test("totals completed approval waits and ignores invalid or pending pairs", () => {
    expect(approvalWaitMs({ approvals: [
      { requestedAt: "2026-10-17T10:00:00.000Z", respondedAt: "2026-10-17T10:00:02.500Z" },
      { requestedAt: "2026-10-17T10:00:03.000Z", respondedAt: null },
    ] })).toBe(2500);
    expect(approvalWaitMs({ approvals: [{ requestedAt: "invalid", respondedAt: "invalid" }] })).toBeNull();
  });
});
