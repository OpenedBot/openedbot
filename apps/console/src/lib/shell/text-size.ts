import { useSyncExternalStore } from "react";

/**
 * Réglages › Apparence › Taille du texte (10 to 14 px), like Escape's « Taille du
 * texte »: a device preference, for the whole app.
 *
 * The console is written for a body text of 14 px. Another choice zooms
 * it instead of rewriting its sizes: text, icons, margins and controls
 * keep their proportions.
 *
 * - Desktop app: the whole WebView is zoomed by the shell, menus and
 *   windows included. The console sets the wanted factor on
 *   `<html data-openedbot-text-zoom>`; `lib/platform/tauri-shell.ts`
 *   forwards it and, once applied, sets `data-native-zoom` and
 *   `--openedbot-native-zoom` on `<html>` (`native-titlebar.css` uses them for the
 *   place of the system buttons, which do not zoom).
 * - Browser: a page cannot set its own zoom (the browser zoom stays with
 *   the user), and a CSS `zoom` on the root would shift every positioned
 *   menu and shrink every `100dvh`. The same factor goes to
 *   `--openedbot-text-scale` on `<html>` instead, which scales the root font
 *   (every rem), the type tokens and the console's pixel sizes
 *   (`styles/components/text-size.css`). Never set in the desktop app: its
 *   zoom already covers them.
 *
 * `index.html` paints the same before the first frame: keep both in step.
 */
export const TEXT_SIZES = [10, 11, 12, 13, 14] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** 14 px by default: a zoom of 1, like the reference app (body text 14/20). */
export const DEFAULT_TEXT_SIZE: TextSize = 14;
/** The body text the console is written for: this size is a zoom of 1. */
const DESIGN_TEXT_SIZE = 14;
/** The key from before the extension to the whole app: the choice already made is kept. */
const STORAGE_KEY = "openedbot:settings-text-size";
/** Read by `lib/platform/tauri-shell.ts`: renaming one without the other cuts the zoom. */
export const TEXT_ZOOM_ATTRIBUTE = "data-openedbot-text-zoom";
/** Read by `styles/components/text-size.css` and the type tokens of `browser/ui-kit`. */
export const TEXT_SCALE_PROPERTY = "--openedbot-text-scale";

const listeners = new Set<() => void>();

function isTextSize(value: unknown): value is TextSize {
  return typeof value === "number" && (TEXT_SIZES as readonly number[]).includes(value);
}

function read(): TextSize {
  try {
    const value = Number(globalThis.localStorage?.getItem(STORAGE_KEY));
    return isTextSize(value) ? value : DEFAULT_TEXT_SIZE;
  } catch {
    // Storage refused: the default size, without blocking the app.
    return DEFAULT_TEXT_SIZE;
  }
}

/** The zoom factor for a size. */
export function textZoom(size: TextSize): number {
  return size / DESIGN_TEXT_SIZE;
}

/** The desktop app: its shell zooms the window (`index.html` reads the same flag). */
function zoomedByShell(view: Window | null | undefined): boolean {
  return Boolean(view?.__OPENEDBOT_SHELL__?.platform);
}

/**
 * Sets the wanted factor on `<html>`: the attribute for the native shell,
 * the property for the page itself in a browser.
 */
function paint(doc: Document | undefined = globalThis.document) {
  if (!doc) return;
  const root = doc.documentElement;
  const zoom = String(textZoom(read()));
  root.setAttribute(TEXT_ZOOM_ATTRIBUTE, zoom);
  if (zoomedByShell(doc.defaultView)) root.style.removeProperty(TEXT_SCALE_PROPERTY);
  else root.style.setProperty(TEXT_SCALE_PROPERTY, zoom);
}

/**
 * Call before the first render: the shell zooms, or the page scales, as soon
 * as it loads, and follows a change made in another window (`storage` event).
 */
export function applyStoredTextSize(doc: Document = document) {
  paint(doc);
  doc.defaultView?.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) paint(doc);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab or the desktop window changes the size: it is followed.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function setTextSize(size: TextSize) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(size));
  } catch {
    // Storage full or refused: nothing is kept, the size stays the one that was read.
    return;
  }
  paint();
  for (const listener of listeners) listener();
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_TEXT_SIZE);
}
