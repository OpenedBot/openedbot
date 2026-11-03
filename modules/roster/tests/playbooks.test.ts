import { describe, expect, test } from "bun:test";
import { buildPlaybookBlock, buildSectionContextBlock, selectPlaybooksForTurn } from "../src/domain/playbooks";

const research = {
  key: "research",
  name: "Research",
  summary: "Cite sources.",
  triggers: ["search", "sources"],
  instructions: "Always cite.",
};

describe("selectPlaybooksForTurn", () => {
  test("sélectionne par trigger, au plus 3", () => {
    expect(selectPlaybooksForTurn([research], "please search Reuters")).toEqual([research]);
    expect(selectPlaybooksForTurn([research], "hello")).toEqual([]);
  });
});

describe("buildPlaybookBlock", () => {
  test("vide sans playbook, et refuse les droits", () => {
    expect(buildPlaybookBlock([])).toBe("");
    expect(buildPlaybookBlock([research])).toContain("grant no tools");
    expect(buildPlaybookBlock([research])).toContain("### Research (research)");
  });
});

describe("buildSectionContextBlock", () => {
  test("vide si le brief l'est, sinon un bloc stable", () => {
    expect(buildSectionContextBlock("  ")).toBe("");
    expect(buildSectionContextBlock("We ship on Fridays.")).toContain("## Team brief");
    expect(buildSectionContextBlock("We ship on Fridays.")).toContain("We ship on Fridays.");
  });
});
