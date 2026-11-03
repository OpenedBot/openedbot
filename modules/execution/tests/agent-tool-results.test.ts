import { describe, expect, test } from "bun:test";
import { projectToolResults } from "../src/domain/agent-tool-results";

function transcript(tool: string, args: Record<string, unknown>, result: unknown, callId = "call-1"): unknown[] {
  return [
    {
      role: "assistant",
      tool_calls: [{
        id: callId,
        type: "function",
        function: { name: tool, arguments: JSON.stringify(args) },
      }],
    },
    { role: "tool", tool_call_id: callId, content: typeof result === "string" ? result : JSON.stringify(result) },
  ];
}

describe("projectToolResults", () => {
  test("projects execute_code input and successful result", () => {
    expect(projectToolResults(transcript("execute_code", { code: "print(42)" }, {
      success: true, output: "42", exit_code: 0,
    }))).toEqual([{
      tool: "execute_code",
      callId: "call-1",
      input: "print(42)",
      result: '{"success":true,"output":"42","exit_code":0}',
      errorMessage: null,
      exitCode: 0,
      status: null,
      truncated: false,
    }]);
  });

  test("uses structured errors, terminal exit codes, and per-URL errors", () => {
    expect(projectToolResults(transcript("execute_code", { code: "raise RuntimeError()" }, {
      success: false, error: "kernel disconnected",
    }))[0]?.errorMessage).toBe("kernel disconnected");
    expect(projectToolResults(transcript("terminal", { command: "false" }, {
      exit_code: 2, output: "", error: null,
    }))[0]).toMatchObject({ input: "false", exitCode: 2, errorMessage: "exit 2" });
    expect(projectToolResults(transcript("web_extract", { url: "https://example.com/page" }, {
      url: "https://example.com/page", error: "upstream denied the request",
    }))[0]?.errorMessage).toBe("upstream denied the request");
  });

  test("prefers the human approval summary and reads non-JSON tool content", () => {
    expect(projectToolResults(transcript("terminal", { command: "protected-action" }, {
      user_summary: "Approval denied by the operator",
      error: "BLOCKED: approval required",
    }))[0]?.errorMessage).toBe("Approval denied by the operator");
    const plain = projectToolResults([
      { role: "assistant", tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: [{ type: "text", text: "first line" }, { type: "text", text: "second line" }] },
    ]);
    expect(plain[0]).toMatchObject({ result: "first line\nsecond line", errorMessage: null });
  });

  test("bounds each field by UTF-8 bytes and marks the projection truncated", () => {
    const [result] = projectToolResults(transcript("execute_code", { code: "é".repeat(5_000) }, "x".repeat(9_000)));
    expect(result?.truncated).toBe(true);
    expect(new TextEncoder().encode(result?.input ?? "").byteLength).toBeLessThanOrEqual(8 * 1024);
    expect(new TextEncoder().encode(result?.result ?? "").byteLength).toBeLessThanOrEqual(8 * 1024);
  });

  test("redacts API keys and bearer values from both input and result", () => {
    const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const bearer = "abcdefghijklmnopqrstuvwx123456";
    const [result] = projectToolResults(transcript("terminal", {
      command: `curl --header 'Authorization: Bearer ${bearer}' --data '${apiKey}'`,
    }, `Authorization: Bearer ${bearer} rejected ${apiKey}`));
    expect(result?.input).toContain("[redacted]");
    expect(result?.result).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(bearer);
  });
});
