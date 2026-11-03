import { describe, expect, test } from "bun:test";
import { BASELINE_REQUIRED_FEATURES, CAPABILITY_BASELINE_VERSION } from "@openedbot/roster/domain/capability-baseline";
import { promptCacheTierForRun, type PromptCacheTierInput } from "../src/domain/prompt-cache-tier";

/** An operator's chat turn on an established bot: the runtime keeps its own tier. */
const chat: PromptCacheTierInput = {
  origin: null,
  originRunId: null,
  stepKind: null,
  workflowKind: null,
  hermesProfileManaged: true,
  linkFeatures: [...BASELINE_REQUIRED_FEATURES, "approval_policy"],
  capabilityBaselineVersion: CAPABILITY_BASELINE_VERSION,
};

describe("prompt-cache tier per run", () => {
  test("a person's turn, in a DM, a room or a workflow they started, keeps the runtime tier", () => {
    expect(promptCacheTierForRun(chat)).toBeNull();
    expect(promptCacheTierForRun({ ...chat, stepKind: "root", workflowKind: "dm" })).toBeNull();
    expect(promptCacheTierForRun({ ...chat, stepKind: "group", workflowKind: "group" })).toBeNull();
  });

  test("a run nobody paces asks for 5m", () => {
    expect(promptCacheTierForRun({ ...chat, origin: "bot_greeting" })).toBe("5m");
    expect(promptCacheTierForRun({ ...chat, originRunId: "run-1" })).toBe("5m");
    expect(promptCacheTierForRun({ ...chat, stepKind: "root", workflowKind: "routine" })).toBe("5m");
    expect(promptCacheTierForRun({ ...chat, stepKind: "group", workflowKind: "routine" })).toBe("5m");
    for (const stepKind of ["delegated", "continuation", "memory", "persona_draft", "compaction"]) {
      expect(promptCacheTierForRun({ ...chat, stepKind })).toBe("5m");
    }
  });

  test("a new bot asks for 5m until its capability baseline is stamped", () => {
    expect(promptCacheTierForRun({ ...chat, capabilityBaselineVersion: 0 })).toBe("5m");
    expect(promptCacheTierForRun({ ...chat, capabilityBaselineVersion: null })).toBe("5m");
    expect(promptCacheTierForRun({ ...chat, capabilityBaselineVersion: CAPABILITY_BASELINE_VERSION - 1 })).toBe("5m");
  });

  test("a bot the baseline never reaches keeps the runtime tier: its tool list does not move", () => {
    expect(promptCacheTierForRun({ ...chat, capabilityBaselineVersion: 0, hermesProfileManaged: false })).toBeNull();
    expect(promptCacheTierForRun({ ...chat, capabilityBaselineVersion: 0, linkFeatures: [BASELINE_REQUIRED_FEATURES[0]!] })).toBeNull();
  });
});
