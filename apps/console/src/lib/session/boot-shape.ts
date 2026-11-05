/**
 * The shape of the desktop sidebar's roster, remembered so that every loading
 * state draws the rows where the real ones will land: the HTML silhouette of
 * `index.html` (it reads the same key, keep the two in step), the frame
 * skeleton of the router and the roster skeleton inside the sidebar.
 *
 * Only counts are kept, never a name: pinned tiles, then one block per
 * section (with or without its label) and its visible rows. The total is
 * capped to what a tall window shows.
 */
export type BootSidebarShape = {
  pins: number;
  blocks: Array<{ label: boolean; rows: number }>;
};

export const BOOT_SIDEBAR_KEY = "openedbot:boot-sidebar";

const MAX_PINS = 6;
const MAX_ROWS = 18;

/** No shape yet (first visit): one labelled list of five rows. */
export const DEFAULT_BOOT_SIDEBAR_SHAPE: BootSidebarShape = { pins: 0, blocks: [{ label: true, rows: 5 }] };

function clampShape(shape: BootSidebarShape): BootSidebarShape {
  let left = MAX_ROWS;
  const blocks: BootSidebarShape["blocks"] = [];
  for (const block of shape.blocks) {
    if (left <= 0) break;
    const rows = Math.max(0, Math.min(Math.floor(block.rows), left));
    blocks.push({ label: block.label === true, rows });
    left -= rows;
  }
  return { pins: Math.max(0, Math.min(Math.floor(shape.pins), MAX_PINS)), blocks };
}

function isShape(value: unknown): value is BootSidebarShape {
  if (typeof value !== "object" || value === null) return false;
  const shape = value as { pins?: unknown; blocks?: unknown };
  return typeof shape.pins === "number" && Array.isArray(shape.blocks)
    && shape.blocks.every((block) => typeof block === "object" && block !== null && typeof (block as { rows?: unknown }).rows === "number");
}

export function readBootSidebarShape(): BootSidebarShape {
  try {
    const raw = globalThis.localStorage?.getItem(BOOT_SIDEBAR_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isShape(parsed) ? clampShape(parsed) : DEFAULT_BOOT_SIDEBAR_SHAPE;
  } catch {
    return DEFAULT_BOOT_SIDEBAR_SHAPE;
  }
}

export function rememberBootSidebarShape(shape: BootSidebarShape): void {
  try {
    const next = JSON.stringify(clampShape(shape));
    if (globalThis.localStorage?.getItem(BOOT_SIDEBAR_KEY) !== next) globalThis.localStorage?.setItem(BOOT_SIDEBAR_KEY, next);
  } catch {
    // Private mode or quota: the next load draws the default shape.
  }
}

/** A conversation route, on the internal or the public (`/o/<slug>/...`) path. */
export function isConversationPath(pathname: string): boolean {
  return /\/(?:bot|g)\/[^/]+\/?$/u.test(pathname);
}
