import { describe, expect, test } from "bun:test";
import { en } from "../src/messages.en";
import { fr } from "../src/messages.fr";

// PERM2-0, PERM2-3: the permission hints describe
// what the pipeline and the host actually do (the legacy `auto` has its own
// line), so they must stay distinct and promise nothing absolute.
const MODES = ["auto", "autoLegacy", "manual", "plan", "bypass"] as const;
const ABSOLUTE = /\b(tout|toute|toutes|rien|jamais|always|never|everything|nothing|any)\b/i;

describe.each([
  ["fr", fr.boardui.permissionHint],
  ["en", en.boardui.permissionHint],
] as const)("permission hints (%s)", (_locale, hints) => {
  test("one distinct hint per mode", () => {
    const values = MODES.map((mode) => hints[mode]);
    expect(values.every((value) => value.trim().length > 0)).toBe(true);
    expect(new Set(values).size).toBe(MODES.length);
  });

  test("no absolute promise and no em dash", () => {
    for (const mode of MODES) {
      expect(hints[mode]).not.toMatch(ABSOLUTE);
      expect(hints[mode]).not.toContain(String.fromCharCode(0x2014));
    }
  });
});
