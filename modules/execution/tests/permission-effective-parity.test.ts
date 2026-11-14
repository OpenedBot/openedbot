import { describe, expect, test } from "bun:test";
import { BOT_PERMISSION_MODES, PERMISSION_CEILINGS, effectiveBotPermission } from "@openedbot/contracts-api";
import { effectivePermissionMode } from "../src/domain/permission-decision";

// PERM2-3: the console shows the effective mode with `effectiveBotPermission`
// (contracts); the pipeline decides with `effectivePermissionMode`. Both must
// agree on every combination under `v2`, and the console shows the stored
// mode under `legacy`, where the pipeline caps nothing.
describe("effective permission mode: console and pipeline agree", () => {
  const ceilings = [null, ...PERMISSION_CEILINGS] as const;
  for (const mode of BOT_PERMISSION_MODES) {
    for (const maxMode of ceilings) {
      for (const enforceReview of [false, true]) {
        for (const reviewProven of [false, true]) {
          test(`${mode} / ceiling ${maxMode ?? "none"} / enforce ${enforceReview} / proven ${reviewProven}`, () => {
            const policy = { mode, ceiling: maxMode, enforceReview, reviewProven };
            const shown = effectiveBotPermission(mode, { pipeline: "v2", maxMode, enforceReview, reviewProven });
            expect(shown.mode).toBe(effectivePermissionMode(policy));
            expect(shown.reason === null).toBe(shown.mode === mode);
            expect(effectiveBotPermission(mode, { pipeline: "legacy", maxMode, enforceReview, reviewProven })).toEqual({ mode, reason: null });
          });
        }
      }
    }
  }

  test("the reason names the last step that lowered the mode", () => {
    const ctx = { pipeline: "v2", maxMode: null, enforceReview: true, reviewProven: false } as const;
    expect(effectiveBotPermission("bypass", ctx)).toEqual({ mode: "manual", reason: "review_unproven" });
    expect(effectiveBotPermission("bypass", { ...ctx, reviewProven: true })).toEqual({ mode: "auto", reason: "enforce_review" });
    expect(effectiveBotPermission("bypass", { ...ctx, maxMode: "manual" })).toEqual({ mode: "manual", reason: "ceiling" });
    expect(effectiveBotPermission(undefined, null)).toEqual({ mode: "manual", reason: null });
  });
});
