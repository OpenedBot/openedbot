import { describe, expect, test } from "bun:test";
import { machineBlock } from "../../src/application/runner/instructions";

describe("machineBlock", () => {
  // 2026-11-18: moved from Hermes to Codex, the bot read « je suis un agent
  // Hermes » in its history and could not say where it ran.
  test("names the machine and its engine, and warns that earlier replies may come from another one", () => {
    const codex = machineBlock({ name: "ubuntu-server · Codex", engine: "local:codex" });
    expect(codex).toContain(`"ubuntu-server · Codex", through Codex`);
    expect(codex).toContain("earlier replies in the history may come from it");
    expect(machineBlock({ name: "kev-homelab", engine: null })).toContain(`"kev-homelab", through Hermes`);
  });
});
