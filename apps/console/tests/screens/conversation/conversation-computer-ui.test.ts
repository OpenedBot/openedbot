import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const DIRECT_CONVERSATION = readFileSync(new URL("../../../src/screens/conversation/conversation.tsx", import.meta.url), "utf8");
const GROUP_CONVERSATION = readFileSync(new URL("../../../src/screens/conversation/group-conversation.tsx", import.meta.url), "utf8");

describe("chrome des conversations", () => {
  test("ne remonte plus l'ancien panneau ordinateur", () => {
    for (const source of [DIRECT_CONVERSATION, GROUP_CONVERSATION]) {
      expect(source).not.toContain("SHOW_COMPUTER_UI");
      expect(source).not.toContain("conversation.compute");
      expect(source).not.toContain("ComputerPanel");
      expect(source).not.toContain("computerOpen");
    }
  });
});
