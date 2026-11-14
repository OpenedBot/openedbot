import { workspaceFrameInPath } from "../workspace/workspace-location";
import { appUrl } from "../platform";

/*
 * Where the cross of the settings modal leads when settings were opened as a
 * route (`/settings/...`), not as the app frame's overlay (which closes back
 * to its own location). Every address is public and tagged with its frame, so
 * the cross never lands in another organization's or client's frame.
 */

const LAST_APP_PATH = "openedbot.boardui.lastAppPath";
const SETTINGS_RETURN = "openedbot.boardui.settingsReturn";

/** A public address and the frame it belongs to (`workspaceFrameInPath`). */
type FramedAddress = { frame: string; href: string };

function publicHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function store(key: string, value: FramedAddress): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused: the cross will return to the frame's home.
  }
}

function read(key: string): FramedAddress | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as Partial<FramedAddress> | null;
    return typeof value?.frame === "string" && typeof value.href === "string" ? { frame: value.frame, href: value.href } : null;
  } catch {
    return null;
  }
}

/** The frame remembers its last screen outside settings, with the frame that carries it: the cross returns there. */
export function rememberAppPath(): void {
  if (window.location.pathname.includes("/settings")) return;
  store(LAST_APP_PATH, { frame: workspaceFrameInPath(window.location.pathname), href: publicHref() });
}

/**
 * Entering settings from another frame (a link to another organization's settings):
 * the cross returns to the address the link was clicked from. Keyed by the
 * settings frame, so another client's settings never reuse it.
 */
export function rememberSettingsReturn(settingsHref: string): void {
  const target = appUrl(settingsHref).pathname;
  store(SETTINGS_RETURN, { frame: workspaceFrameInPath(target), href: publicHref() });
}

/** Where the cross of directly opened settings leads: never an address of another frame. */
export function settingsCloseHref(): string {
  const frame = workspaceFrameInPath(window.location.pathname);
  const origin = read(SETTINGS_RETURN);
  if (origin?.frame === frame) return origin.href;
  const last = read(LAST_APP_PATH);
  if (last && last.frame === frame) return last.href;
  return `${frame}/`;
}

export function forgetSettingsReturn(): void {
  try {
    window.sessionStorage.removeItem(SETTINGS_RETURN);
  } catch {
    // Nothing to forget.
  }
}
