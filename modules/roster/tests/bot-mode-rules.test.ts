import { describe, expect, test } from "bun:test";
import { buildBotModeInstructions, DIAGRAM_RULE, FILE_DELIVERY_RULE, SANDBOX_PACKAGES_RULE } from "../src/domain/bot-mode";

const shared = {
  self: { name: "Assistant", slug: "assistant", description: null },
  others: [],
  operator: { username: "operator" },
};

describe("bot mode rules for diagrams and files", () => {
  test("a diagram is answered as Mermaid, before the image-file rule", () => {
    const block = buildBotModeInstructions(shared);
    expect(block).toContain(DIAGRAM_RULE);
    expect(DIAGRAM_RULE).toContain("```mermaid");
    expect(block.indexOf(DIAGRAM_RULE)).toBeLessThan(block.indexOf(FILE_DELIVERY_RULE));
  });

  test("a delivered file must be written in the same turn (host trust window)", () => {
    expect(buildBotModeInstructions(shared)).toContain(FILE_DELIVERY_RULE);
    expect(FILE_DELIVERY_RULE).toContain("a file older than ten minutes is not delivered");
    expect(FILE_DELIVERY_RULE).toContain("`MEDIA:/workspace/<name>`");
  });

  test("packages a script needs are installed in the same command, never discovered by a failure", () => {
    const block = buildBotModeInstructions(shared);
    expect(block).toContain(SANDBOX_PACKAGES_RULE);
    expect(SANDBOX_PACKAGES_RULE).toContain("`pip install -q matplotlib && python3 chart.py`");
    expect(block.indexOf(FILE_DELIVERY_RULE)).toBeLessThan(block.indexOf(SANDBOX_PACKAGES_RULE));
  });
});
