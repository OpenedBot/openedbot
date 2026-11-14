import { describe, expect, test } from "bun:test";
import type { RunDto } from "@openedbot/contracts-api";
import { latestRunFallback, sameRunFallback } from "../../../src/lib/run/run-fallback";

const run = (id: string, createdAt: string, botId = "bot-a", status: RunDto["status"] = "completed") =>
  ({ id, createdAt, botId, status });
const fallback = (runId: string, to: string, model: string, from = "xai-oauth") => ({
  runId, type: "run.provider_fallback", payload: { from, to, model, reason: "quota" },
});

describe("latestRunFallback", () => {
  test("names who served the bot's latest turn when it was re-routed", () => {
    expect(latestRunFallback(
      [run("r1", "2026-10-24T01:00:00Z"), run("r2", "2026-10-24T01:05:00Z")],
      [fallback("r2", "anthropic", "claude-fable-5.1")],
      "bot-a",
    )).toEqual({ runId: "r2", from: "xai-oauth", provider: "anthropic", model: "claude-fable-5.1" });
  });

  test("an older fallback says nothing once a later turn ran on its own model", () => {
    expect(latestRunFallback(
      [run("r1", "2026-10-24T01:00:00Z"), run("r2", "2026-10-24T01:05:00Z")],
      [fallback("r1", "anthropic", "claude-fable-5.1")],
      "bot-a",
    )).toBeNull();
  });

  test("the second model tried on the fallback provider wins, and other bots are ignored", () => {
    expect(latestRunFallback(
      [run("r1", "2026-10-24T01:00:00Z"), run("r9", "2026-10-24T02:00:00Z", "bot-b")],
      [fallback("r1", "anthropic", "claude-fable-5.1"), fallback("r1", "anthropic", "claude-haiku-5", "anthropic"),
        fallback("r9", "openrouter", "x")],
      "bot-a",
    )).toEqual({ runId: "r1", from: "anthropic", provider: "anthropic", model: "claude-haiku-5" });
    expect(latestRunFallback([], [], "bot-a")).toBeNull();
    expect(latestRunFallback([run("r1", "2026-10-24T01:00:00Z")], [{ runId: "r1", type: "run.provider_fallback", payload: { to: "" } }], "bot-a")).toBeNull();
  });

  test("a fallback is only served once its turn completed: an attempt or a failure is not", () => {
    const events = [fallback("r2", "anthropic", "claude-fable-5.1")];
    const history = (status: RunDto["status"]) => [run("r1", "2026-10-24T01:00:00Z"), run("r2", "2026-10-24T01:05:00Z", "bot-a", status)];
    for (const status of ["queued", "starting", "running", "awaiting_approval", "failed", "cancelled"] as const) {
      expect(latestRunFallback(history(status), events, "bot-a")).toBeNull();
    }
    expect(latestRunFallback(history("completed"), events, "bot-a")?.model).toBe("claude-fable-5.1");
  });

  test("equality is by content", () => {
    const value = { runId: "r1", from: null, provider: "anthropic", model: "m" };
    expect(sameRunFallback(value, { ...value })).toBe(true);
    expect(sameRunFallback(value, { ...value, model: "n" })).toBe(false);
    expect(sameRunFallback(null, value)).toBe(false);
    expect(sameRunFallback(null, null)).toBe(true);
  });
});
