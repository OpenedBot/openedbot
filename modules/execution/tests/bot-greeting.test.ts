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

describe("greetingRunsOnDefaultProfile (DEV-OHB-244)", () => {
  const thread = "ohb:org:thread";
  const base = { origin: "bot_greeting", threadSessionId: thread, executionSessionKey: null, hermesRunId: null };

  test("a greeting does not wait for its profile while provisioning runs", () => {
    expect(greetingRunsOnDefaultProfile({ ...base, profileProvisionStatus: "queued" })).toBe(true);
    expect(greetingRunsOnDefaultProfile({ ...base, profileProvisionStatus: "running" })).toBe(true);
    expect(greetingRunsOnDefaultProfile({ ...base, profileProvisionStatus: "succeeded" })).toBe(false);
    expect(greetingRunsOnDefaultProfile({ ...base, profileProvisionStatus: null })).toBe(false);
    expect(greetingRunsOnDefaultProfile({ ...base, origin: null, profileProvisionStatus: "running" })).toBe(false);
  });

  test("the pinned greeting session keeps the choice once the profile is ready", () => {
    const pinned = { ...base, executionSessionKey: greetingSessionKey(thread), hermesRunId: "run-1" };
    expect(greetingRunsOnDefaultProfile({ ...pinned, profileProvisionStatus: "succeeded" })).toBe(true);
    expect(greetingRunsOnDefaultProfile({ ...base, hermesRunId: "run-1", profileProvisionStatus: "running" })).toBe(false);
  });
});
