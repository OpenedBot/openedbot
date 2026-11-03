import { describe, expect, test } from "bun:test";
import { formatPersonaDraftTranscript, personaDraftSessionKey } from "../src/domain/persona-draft";

describe("persona-draft", () => {
  test("isole la session par org et bot", () => {
    expect(personaDraftSessionKey("org-1", "bot-1")).toBe("ohb:org-1:persona-draft:bot:bot-1");
  });

  test("formate un transcript lisible", () => {
    expect(formatPersonaDraftTranscript([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi" },
    ])).toBe("User: Hello\n\nAssistant: Hi");
    expect(formatPersonaDraftTranscript([])).toBe("No messages.");
  });
});
