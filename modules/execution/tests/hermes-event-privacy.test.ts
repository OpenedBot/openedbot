import { describe, expect, test } from "bun:test";
import { HermesEventNormalizer, TOOL_ERROR_MESSAGE_MAX_CHARS, hermesRunFailure } from "../src/domain/hermes-events";

describe("public runtime event boundary", () => {
  test("tool previews retain useful text while redacting quoted JSON credentials", () => {
    const sentinel = "fixture-private-value-with-spaces";
    const normalizer = new HermesEventNormalizer();
    const [event] = normalizer.push({ event: "tool.started", run_id: "fixture-run", tool: "web", timestamp: 1,
      preview: `search public docs ${JSON.stringify({ apiKey: sentinel, password: `${sentinel} 'extra' "words"` })}` });
    expect(event?.type).toBe("tool.call");
    expect(event?.payload.preview).toContain("search public docs");
    expect(event?.payload.preview).toContain("[redacted]");
    expect(JSON.stringify(event)).not.toContain(sentinel);
  });

  test("attached tool inputs and results redact credentials without flattening lines", () => {
    const bearer = "fixture-bearer-value-long-enough";
    const normalizer = new HermesEventNormalizer();
    normalizer.push({ event: "tool.started", run_id: "fixture-run", tool: "terminal", timestamp: 1,
      tool_call_id: "upstream-call" });
    const [attached] = normalizer.attachToolResults([
      { role: "assistant", tool_calls: [{ id: "upstream-call", function: { name: "terminal", arguments: JSON.stringify({ command: `echo one\necho Bearer ${bearer}` }) } }] },
      { role: "tool", tool_call_id: "upstream-call", content: `first line\nBearer ${bearer}` },
    ]);
    expect(attached?.payload.input).toContain("\n");
    expect(attached?.payload.input).toContain("[redacted]");
    expect(attached?.payload.result).toContain("\n");
    expect(attached?.payload.result).toContain("[redacted]");
    expect(JSON.stringify(attached)).not.toContain(bearer);
  });

  test("structured tool arguments are not a display preview and long text is bounded", () => {
    const normalizer = new HermesEventNormalizer();
    const [structured] = normalizer.push({ event: "tool.started", run_id: "fixture-run", tool: "web", timestamp: 1,
      preview: { privateInput: "fixture-private" } });
    expect(structured?.payload.preview).toBeNull();
    const [long] = normalizer.push({ event: "tool.started", run_id: "fixture-run", tool: "web", timestamp: 2,
      preview: "safe text ".repeat(1_000) });
    expect(String(long?.payload.preview).length).toBeLessThanOrEqual(TOOL_ERROR_MESSAGE_MAX_CHARS);
  });

  test("unknown event bodies and unrecognized approval responses remain private", () => {
    const normalizer = new HermesEventNormalizer();
    const [unknown] = normalizer.push({ event: "internal.coordination", run_id: "fixture-run", timestamp: 1,
      privateState: { content: "fixture-private" } });
    expect(unknown?.payload).toEqual({ event: "internal.coordination" });
    const [approval] = normalizer.push({ event: "approval.responded", run_id: "fixture-run", timestamp: 2,
      choice: "unrecognized", privateState: "fixture-private" });
    expect(approval?.payload).toEqual({ event: "approval.responded" });
    expect(JSON.stringify([unknown, approval])).not.toContain("fixture-private");
  });

  test("a public run error cannot echo a credential", () => {
    const sentinel = "fixture-private-authorization";
    const failure = hermesRunFailure({ message: `failed {"authorization":"${sentinel}"}` });
    expect(failure.message).toContain("failed");
    expect(failure.message).toContain("[redacted]");
    expect(failure.message).not.toContain(sentinel);
  });

  test("approval display fields are redacted and choices stay within the public vocabulary", () => {
    const sentinel = "fixture-private-approval-value";
    const [approval] = new HermesEventNormalizer().push({ event: "approval.request", run_id: "fixture-run",
      timestamp: 1, command: `fixture action ${JSON.stringify({ token: sentinel })}`,
      description: JSON.stringify({ password: sentinel }), choices: ["once", "deny", { privateState: sentinel }] });
    expect(approval?.type).toBe("approval.requested");
    expect(approval?.payload.command).toContain("fixture action");
    expect(approval?.payload.command).toContain("[redacted]");
    expect(approval?.payload.description).toContain("[redacted]");
    expect(approval?.payload.choices).toEqual(["once", "deny"]);
    expect(JSON.stringify(approval)).not.toContain(sentinel);
  });
});
