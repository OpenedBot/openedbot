import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { log } from "./log";
import { DEFAULT_TEXT_ZOOM, isTextZoom } from "../shared/bridge";

/**
 * How the app shows itself: the console window, the native popup (macOS, the
 * openedbot Notch helper), or both. "window" is the default and the only value on
 * Windows until a Windows popup exists.
 */
export type DisplayMode = "window" | "popup" | "both";

export type Preferences = {
  alwaysOnTop: boolean;
  bounds: Electron.Rectangle | null;
  displayMode: DisplayMode;
  /**
   * The console's last text size, as a page zoom. Kept here so the next
   * launch and every reload paint at that size from the first frame, before
   * the console's JavaScript runs and says it again.
   */
  textZoom: number;
};

const DISPLAY_MODES: readonly DisplayMode[] = ["window", "popup", "both"];

export function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === "string" && (DISPLAY_MODES as readonly string[]).includes(value);
}

function preferencesFile(): string {
  return path.join(app.getPath("userData"), "preferences.json");
}

function isRectangle(value: unknown): value is Electron.Rectangle {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => Number.isFinite(record[key]));
}

// One object for the whole process: the window (bounds, stay-on-top) and the
// display mode share the file, so two writers with their own copy would
// overwrite each other's fields.
let shared: Preferences | null = null;

export function loadPreferences(): Preferences {
  if (shared) return shared;
  let parsed: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(preferencesFile(), "utf8"));
    if (typeof raw === "object" && raw !== null) parsed = raw as Record<string, unknown>;
  } catch {
    // Missing on first launch, or unreadable: defaults.
  }
  shared = {
    alwaysOnTop: parsed.alwaysOnTop === true,
    bounds: isRectangle(parsed.bounds) ? parsed.bounds : null,
    displayMode: isDisplayMode(parsed.displayMode) ? parsed.displayMode : "window",
    textZoom: isTextZoom(parsed.textZoom) ? parsed.textZoom : DEFAULT_TEXT_ZOOM,
  };
  return shared;
}

/** Persists the shared preferences (the argument is that same object, kept for call-site clarity). */
export function savePreferences(preferences: Preferences = loadPreferences()): void {
  try {
    const file = preferencesFile();
    mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated file.
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(preferences));
    renameSync(temporary, file);
  } catch (error) {
    log.warn(`could not persist preferences (${error instanceof Error ? error.message : "error"})`);
  }
}
