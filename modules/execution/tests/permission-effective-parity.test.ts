import { describe, expect, test } from "bun:test";
import { BOT_PERMISSION_MODES, PERMISSION_CEILINGS, effectiveBotPermission, yoloPolicyBlock } from "@openedbot/contracts-api";
import { effectivePermissionMode } from "../src/domain/permission-decision";

// PERM2-3: the console shows the effective mode with `effectiveBotPermission`
// (contracts); the pipeline decides with `effectivePermissionMode`. Both must
// agree on every combination under `v2`, mode AND reason (a downgrade is
// never silent on either side), and the console shows the stored mode under
// `legacy`, where the pipeline caps nothing.
describe("effective permission mode: console and pipeline agree", () => {
  const ceilings = [null, ...PERMISSION_CEILINGS] as const;
  for (const mode of BOT_PERMISSION_MODES) {
    for (const maxMode of ceilings) {
      for (const enforceReview of [false, true]) {
        for (const reviewProven of [false, true]) {
          test(`${mode} / ceiling ${maxMode ?? "none"} / enforce ${enforceReview} / proven ${reviewProven}`, () => {
            const policy = { mode, ceiling: maxMode, enforceReview, reviewProven };
            const shown = effectiveBotPermission(mode, { pipeline: "v2", maxMode, enforceReview, reviewProven });
            expect({ mode: shown.mode, reason: shown.reason }).toEqual(effectivePermissionMode(policy));
            expect(shown.reason === null).toBe(shown.mode === mode);
            expect(effectiveBotPermission(mode, { pipeline: "legacy", maxMode, enforceReview, reviewProven })).toEqual({ mode, reason: null, yolo: null });
          });
        }
      }
    }
  }

  test("the reason names the last step that lowered the mode", () => {
    const ctx = { pipeline: "v2", maxMode: null, enforceReview: true, reviewProven: false } as const;
    expect(effectiveBotPermission("bypass", ctx)).toEqual({ mode: "manual", reason: "review_unproven", yolo: null });
    expect(effectiveBotPermission("bypass", { ...ctx, reviewProven: true })).toEqual({ mode: "auto", reason: "enforce_review", yolo: null });
    expect(effectiveBotPermission("bypass", { ...ctx, maxMode: "manual" })).toEqual({ mode: "manual", reason: "ceiling", yolo: null });
    expect(effectiveBotPermission(undefined, null)).toEqual({ mode: "manual", reason: null, yolo: null });
    expect(effectivePermissionMode({ mode: "bypass", ceiling: "manual", enforceReview: true, reviewProven: false })).toEqual({ mode: "manual", reason: "ceiling" });
    expect(effectivePermissionMode({ mode: "auto", ceiling: null, enforceReview: false, reviewProven: false })).toEqual({ mode: "manual", reason: "review_unproven" });
    expect(effectivePermissionMode({ mode: "plan", ceiling: "manual", enforceReview: true, reviewProven: false })).toEqual({ mode: "plan", reason: null });
  });

  test("the YOLO state rides along, it never changes the mode or its reason", () => {
    const yolo = { leaseId: "5d0c7f3e-0000-4000-8000-000000000001", scope: "thread", expiresAt: "2026-11-01T04:00:00.000Z" } as const;
    const ctx = { pipeline: "v2", maxMode: null, enforceReview: false, reviewProven: true } as const;
    expect(effectiveBotPermission("manual", ctx, yolo)).toEqual({ mode: "manual", reason: null, yolo });
    expect(effectiveBotPermission("bypass", { ...ctx, maxMode: "auto" }, yolo)).toEqual({ mode: "auto", reason: "ceiling", yolo });
  });

  test("a YOLO lease is refused where bypass would be, with the reason", () => {
    expect(yoloPolicyBlock({ maxMode: null, enforceReview: false })).toBeNull();
    expect(yoloPolicyBlock({ maxMode: "bypass", enforceReview: false })).toBeNull();
    expect(yoloPolicyBlock({ maxMode: "auto", enforceReview: false })).toBe("ceiling");
    expect(yoloPolicyBlock({ maxMode: "manual", enforceReview: true })).toBe("ceiling");
    expect(yoloPolicyBlock({ maxMode: null, enforceReview: true })).toBe("enforce_review");
  });
});
