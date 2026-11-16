import { describe, expect, test } from "bun:test";
import { buildBotModeInstructions, buildGroupInstructions, DIAGRAM_RULE, FILE_DELIVERY_RULE, SANDBOX_PACKAGES_RULE, TOOL_RELEVANCE_RULE } from "../src/domain/bot-mode";
import { buildRuntimeMemoryBlock } from "../src/domain/bot-memory";
import { buildLearningBlock } from "../src/domain/bot-learning";

const shared = {
  self: { name: "Assistant", slug: "assistant", description: null },
  others: [],
  operator: { username: "operator" },
};

describe("tool relevance in conversation", () => {
  test("the full permanent guidance stays bounded and byte-stable for the same capabilities", () => {
    const build = () => [
      buildBotModeInstructions({ ...shared, routineTool: "enabled", memoryToolEnabled: true, botSettingsToolEnabled: true, webToolsEnabled: true }),
      buildRuntimeMemoryBlock({ toolEnabled: true }),
      buildLearningBlock({ memoryToolEnabled: true }),
    ].join("\n\n");
    // Before tightening the permanent guidance: 9,749 characters including separators.
    // User history and persona are outside this budget and are never shortened here.
    expect(build().length).toBeLessThan(8_500);
    expect(build()).toBe(build());
  });
  test("autonomy is bounded to the latest message (2026-11-16)", () => {
    const block = buildBotModeInstructions({ ...shared, routineTool: "enabled" });
    expect(block).toContain("- Work autonomously on the user's latest message: when its task is clear, act");
    expect(block).toContain("Earlier messages are context, not tasks to resume.");
    expect(block).not.toContain("- Work autonomously: when the task is clear, act");
  });
  test("small talk excludes discovery even with routines and web tools enabled", () => {
    const block = buildBotModeInstructions({ ...shared, routineTool: "enabled", webToolsEnabled: true });
    expect(block).toContain(TOOL_RELEVANCE_RULE);
    expect(TOOL_RELEVANCE_RULE).toContain("without any tool call, including `tool_search` or `tool_describe`");
    expect(TOOL_RELEVANCE_RULE).toContain("ça va ti ?");
    expect(TOOL_RELEVANCE_RULE).toContain("fulfill an action or information request mixed with a greeting");
    expect(TOOL_RELEVANCE_RULE).toContain("An answer to an active question, choice or proposal");
    expect(TOOL_RELEVANCE_RULE).toContain('"oui", "OK"');
  });

  test("room answers receive the same relevance rule", () => {
    const block = buildGroupInstructions({ ...shared, members: [], group: { name: "Team", instructions: "" }, maxRounds: 2, addressed: true });
    expect(block).toContain(TOOL_RELEVANCE_RULE);
  });
});

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
