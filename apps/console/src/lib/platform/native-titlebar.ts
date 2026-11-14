import { nativeBridge, type OpenedbotNativeBridge } from "./native-bridge";

/**
 * The desktop app's title bar.
 *
 * The app opens its window with no title bar: the console goes up to the top
 * edge and its top bar (`board-chrome.tsx`, 46 px) becomes the window's,
 * like Codex, ChatGPT or the reference app. So it is the console that serves as the
 * handle to move the window and that leaves room for the system
 * buttons (`styles/components/native-titlebar.css`):
 *
 * - macOS (`"mac"`): the traffic lights float in the top-left corner;
 * - Windows (`"windows"`): room for minimize, maximize and close in the
 *   top-right corner (`env(titlebar-area-*)`, 46 px tall), for the coming
 *   Windows shell (D4).
 *
 * Detection: the bridge present AND the system it announces (`shell.platform`).
 * Under Linux, the window keeps the system bar. In a browser or a
 * PWA, nothing changes.
 */
export type NativeTitlebar = "mac" | "windows";

export const NATIVE_TITLEBAR_ATTRIBUTE = "data-native-titlebar";
export const NATIVE_TITLEBAR_BAND_ATTRIBUTE = "data-native-titlebar-band";

export function nativeTitlebarFor(bridge: OpenedbotNativeBridge | null): NativeTitlebar | null {
  switch (bridge?.shell?.platform) {
    case "macos":
      return "mac";
    case "windows":
      return "windows";
    default:
      return null;
  }
}

/**
 * To call before the first render: `<html>` carries the attribute from the first
 * paint, with no layout jump. Also sets the drag band at the
 * top of the window, once, as the first child of `<body>`: Chromium applies
 * drag regions in document order, so everything that comes
 * after can cut itself out of it.
 */
export function applyNativeTitlebar(doc: Document = document): NativeTitlebar | null {
  const titlebar = nativeTitlebarFor(nativeBridge());
  if (!titlebar) return null;
  doc.documentElement.setAttribute(NATIVE_TITLEBAR_ATTRIBUTE, titlebar);
  if (!doc.querySelector(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`)) {
    const band = doc.createElement("div");
    band.setAttribute(NATIVE_TITLEBAR_BAND_ATTRIBUTE, "");
    band.setAttribute("aria-hidden", "true");
    doc.body.prepend(band);
  }
  return titlebar;
}
/** Re-exported for the frame (`BoardFrame`), which already reads its titlebar from here. */
export { TITLEBAR_ANCHOR_ATTRIBUTE } from "./tauri-shell";
