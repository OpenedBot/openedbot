import { describe, expect, test } from "bun:test";
import { botGreetingInput, greetingRunsOnDefaultProfile, greetingSessionKey } from "../src/domain/bot-greeting";

describe("bot greeting input", () => {
  test("defines a short first contact and the ask_user ending", () => {
    const input = botGreetingInput({
      name: "Atlas",
      role: "Research assistant",
      mission: "Find concise, sourced answers.",
      replyLanguage: "auto",
    });
    expect(input).toContain("[openedbot first contact]");
    expect(input).toContain("Your name is Atlas.");
    expect(input).toContain("Your role is Research assistant.");
    expect(input).toContain("Your mission is Find concise, sourced answers.");
    expect(input).toContain("Do not call any tool.");
    expect(input).toContain("last line `@user <question>` followed by 2 to 4 lines `- <short option>`");
    expect(input).toContain("Write in the language of your instructions.");
  });

  test("in auto, greets in the operator's interface language", () => {
    expect(botGreetingInput({ name: "Atlas", role: null, mission: null, replyLanguage: "auto", operatorLocale: "fr" }))
      .toContain("Write in French, your operator's language.");
    expect(botGreetingInput({ name: "Atlas", role: null, mission: null, replyLanguage: "de", operatorLocale: "fr" }))
      .toContain("Write in German.");
  });

  test("uses the configured reply language", () => {
    expect(botGreetingInput({ name: "Atlas", role: null, mission: null, replyLanguage: "fr" }))
      .toContain("Write in French.");
  });
});

describe("greetingRunsOnDefaultProfile", () => {
  const thread = "openedbot:org:thread";
  const base = { origin: "bot_greeting", threadSessionId: thread, executionSessionKey: null };

  test("a new greeting waits for the bot's profile and runs on it", () => {
    expect(greetingRunsOnDefaultProfile(base)).toBe(false);
    expect(greetingRunsOnDefaultProfile({ ...base, executionSessionKey: "openedbot:org:thread:g1" })).toBe(false);
  });

  test("a greeting pinned to its own session by an earlier version stays on the default profile", () => {
    expect(greetingRunsOnDefaultProfile({ ...base, executionSessionKey: greetingSessionKey(thread) })).toBe(true);
    expect(greetingRunsOnDefaultProfile({ ...base, origin: null, executionSessionKey: greetingSessionKey(thread) })).toBe(false);
  });
});
