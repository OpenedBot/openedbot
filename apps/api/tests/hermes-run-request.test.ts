import { describe, expect, test } from "bun:test";
import { hermesRunRequestBody } from "@openedbot/hermes";

describe("Hermes run request contract", () => {
  test("sends the runtime selection using the current Hermes API shape", () => {
    const body = hermesRunRequestBody({
      input: "hello",
      instructions: "be concise",
      sessionId: "session-1",
      provider: "opencode-free",
      model: "deepseek-v4-flash-free",
      reasoningEffort: "medium",
      conversationHistory: [{ role: "user", content: "previous" }],
    });

    expect(body).toEqual({
      input: "hello",
      instructions: "be concise",
      session_id: "session-1",
      provider: "opencode-free",
      model: "deepseek-v4-flash-free",
      model_options: { reasoning_effort: "medium" },
      conversation_history: [{ role: "user", content: "previous" }],
    });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  test("omits optional selection fields instead of sending empty values", () => {
    expect(hermesRunRequestBody({
      input: "hello",
      instructions: "",
      sessionId: "session-1",
      provider: null,
      model: null,
      reasoningEffort: null,
    })).toEqual({ input: "hello", instructions: "", session_id: "session-1" });
  });
});
