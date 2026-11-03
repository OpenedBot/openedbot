import { describe, expect, test } from "bun:test";
import { buildPlaybookBlock, selectPlaybooksForTurn } from "@openedbot/roster/domain/playbooks";
import { buildPlanTurnBlock } from "@openedbot/roster/domain/editor-directives";
import { withTurnGuidance } from "../../src/application/runner/instructions";

const research = {
  key: "research",
  name: "Research",
  summary: "Cite sources.",
  triggers: ["reuters"],
  instructions: "Open two sources before answering.",
};

describe("withTurnGuidance", () => {
  test("puts the triggered playbooks at the head of the input", () => {
    const block = buildPlaybookBlock(selectPlaybooksForTurn([research], "search Reuters"));
    const input = withTurnGuidance("search Reuters", [null, block]);
    expect(input.startsWith("## Playbooks")).toBe(true);
    expect(input.endsWith("\n\nsearch Reuters")).toBe(true);
  });

  test("leaves the input untouched when nothing triggers", () => {
    expect(withTurnGuidance("hello", [null, buildPlaybookBlock(selectPlaybooksForTurn([research], "hello"))])).toBe("hello");
  });

  test("puts a one-message plan intent first, then the playbooks", () => {
    const input = withTurnGuidance("search Reuters", [buildPlanTurnBlock(), buildPlaybookBlock([research])]);
    expect(input.indexOf("## This message only: plan first")).toBe(0);
    expect(input.indexOf("## Playbooks")).toBeGreaterThan(0);
    expect(input.endsWith("\n\nsearch Reuters")).toBe(true);
  });
});
