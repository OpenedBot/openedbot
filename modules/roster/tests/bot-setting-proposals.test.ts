import { describe, expect, test } from "bun:test";
import { canonicalBotSettingProposalHash } from "../src/application/bot-setting-proposals";
import { buildBotModeInstructions } from "../src/domain/bot-mode";

describe("bot setting proposal hashes", () => {
  test("canonicalizes object key order", () => {
    const left = canonicalBotSettingProposalHash({ instructions: "New persona", label: "Calm", notifyOnFinish: true });
    const right = canonicalBotSettingProposalHash({ notifyOnFinish: true, label: "Calm", instructions: "New persona" });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  test("explains the operator approval gate when enabled and disabled", () => {
    const shared = {
      self: { name: "Assistant", slug: "assistant", description: null },
      others: [],
      operator: { username: "operator" },
    };
    const enabled = buildBotModeInstructions({ ...shared, botSettingsToolEnabled: true });
    expect(enabled).toContain("call `bot_settings_propose` with the full new value and a one-line reason");
    expect(enabled).toContain("only after the operator approves the proposal card in this thread");
    expect(enabled).toContain("Never claim it is done before approval.");

    const disabled = buildBotModeInstructions({ ...shared, botSettingsToolEnabled: false });
    expect(disabled).toContain("You cannot change your own persona or settings.");
    expect(disabled).toContain("Persona / General");
    expect(disabled).toContain("self-edit proposals");
  });

  test("adds the world-information rule only when the web toolset is active", () => {
    const shared = {
      self: { name: "Assistant", slug: "assistant", description: null },
      others: [],
      operator: { username: "operator" },
    };
    const on = buildBotModeInstructions({ ...shared, webToolsEnabled: true });
    expect(on).toContain("`web_search`, then `web_extract` on the best one or two pages");
    expect(on).toContain("Keep `execute_code` and the terminal for calculations");
    expect(buildBotModeInstructions({ ...shared })).not.toContain("`web_extract` on the best");
  });
});
