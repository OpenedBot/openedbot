import { describe, expect, test } from "bun:test";
import { EDGE_SETUP_INSTALL_STEPS } from "../../../../src/screens/settings/installation/cloud-enrollment";

describe("edge-setup install steps", () => {
  test("install through the signature-checking bootstrap, never the retired GitHub repository", () => {
    const text = EDGE_SETUP_INSTALL_STEPS.map((step) => `${step.value}\n${step.hint}`).join("\n");
    expect(text).not.toContain("github.com");
    expect(text).not.toContain("GitHub");
    expect(EDGE_SETUP_INSTALL_STEPS[0]!.value).toBe(
      "curl --proto '=https' --tlsv1.2 -fsSL https://docs.openedbot.app/install | sh",
    );
  });

  test("no step installs a binary that skipped the signature check", () => {
    for (const step of EDGE_SETUP_INSTALL_STEPS) {
      expect(step.value).not.toContain("sudo install");
      expect(step.value).not.toContain("SHA256SUMS");
    }
    expect(EDGE_SETUP_INSTALL_STEPS.at(-1)!.value).toBe("sudo edge-setup up --yes");
  });
});
