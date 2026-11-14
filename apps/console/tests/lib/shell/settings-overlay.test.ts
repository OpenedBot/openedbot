import { describe, expect, test } from "bun:test";
import {
  SETTINGS_OVERLAY_STATE_KEY,
  isOverlaySettingsPath,
  settingsOverlayPath,
} from "../../../src/lib/shell/settings-overlay";

// Activity moved from `/settings` to `/settings/activity` on 08-11-2026:
// `/settings` is the phone's list of sections and, on desktop, a redirect.
describe("settings overlay paths", () => {
  test("Activity is a section at /settings/activity, /settings is not one", () => {
    expect(isOverlaySettingsPath("/settings/activity")).toBe(true);
    expect(isOverlaySettingsPath("/settings/account")).toBe(true);
    expect(isOverlaySettingsPath("/settings")).toBe(false);
  });

  test("a history entry written before the move reopens Activity", () => {
    expect(settingsOverlayPath({ [SETTINGS_OVERLAY_STATE_KEY]: "/settings" })).toBe("/settings/activity");
    expect(settingsOverlayPath({ [SETTINGS_OVERLAY_STATE_KEY]: "/settings/activity" })).toBe("/settings/activity");
    expect(settingsOverlayPath({ [SETTINGS_OVERLAY_STATE_KEY]: "/settings/nope" })).toBeNull();
    expect(settingsOverlayPath(null)).toBeNull();
  });
});
