import { createContext, useContext } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { SHOW_DEV_SETTINGS } from "./dev-settings-ui";
import type { RuntimeSection } from "../../screens/settings/installation/cloud/cloud-shared";

/**
 * The settings sections. On desktop they open as a page of the frame
 * since 02-11-2026 (the window above the current screen was removed,
 * operator decision). The overlay now only serves the desktop compact
 * window, which opens the section in the browser (`compact-frame.tsx`), and
 * `settingsOverlayPath` rereads the history entries written in the days of the
 * window (`SettingsOverlayHost`).
 */
export const OVERLAY_SETTINGS_PATHS = [
  "/settings/activity",
  "/settings/account",
  "/settings/agents",
  "/settings/runtime",
  "/settings/models",
  "/settings/appearance",
  "/settings/updates",
  "/settings/notch",
  "/settings/archives",
  "/settings/connectors",
  "/settings/notifications",
  "/settings/decisions",
  "/settings/policies",
  "/settings/security",
  "/settings/billing",
  "/settings/developer",
] as const;

export type OverlaySettingsPath = (typeof OVERLAY_SETTINGS_PATHS)[number];

const DEV_ONLY_PATHS: ReadonlySet<string> = new Set(["/settings/billing", "/settings/developer"]);
const OVERLAY_PATHS: ReadonlySet<string> = new Set(OVERLAY_SETTINGS_PATHS);

/** The history-state key that carries the section open as an overlay. */
export const SETTINGS_OVERLAY_STATE_KEY = "openedbotSettingsOverlay";

export function isOverlaySettingsPath(path: string): path is OverlaySettingsPath {
  return OVERLAY_PATHS.has(path) && (SHOW_DEV_SETTINGS || !DEV_ONLY_PATHS.has(path));
}

/** The section open as an overlay according to the history state, or `null`. */
export function settingsOverlayPath(state: unknown): OverlaySettingsPath | null {
  if (typeof state !== "object" || state === null) return null;
  const value = (state as Record<string, unknown>)[SETTINGS_OVERLAY_STATE_KEY];
  // An entry written before Activity moved to `/settings/activity` (08-11-2026).
  if (value === "/settings") return "/settings/activity";
  return typeof value === "string" && isOverlaySettingsPath(value) ? value : null;
}

export type SettingsOverlay = {
  open: (to: OverlaySettingsPath, options?: { section?: RuntimeSection; replace?: boolean }) => void;
  close: () => void;
};

/** Provided by the desktop compact window only. */
export const SettingsOverlayContext = createContext<SettingsOverlay | null>(null);

export function useSettingsOverlay(): SettingsOverlay | null {
  return useContext(SettingsOverlayContext);
}

/**
 * Opens a settings section: as a page, except in the desktop compact
 * window, which hands it to the browser.
 *
 * With no section: « Mon compte » on desktop (the gear, the account menu, the
 * palette), « Activité » living at `/settings/activity` since 08-11-2026; on a
 * phone, `/settings` is the list of sections.
 */
export function useOpenSettings(): (to?: string) => void {
  const overlay = useSettingsOverlay();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  return (to = isMobile ? "/settings" : "/settings/account") => {
    if (overlay && isOverlaySettingsPath(to)) overlay.open(to);
    else void navigate({ to });
  };
}
