import { contextBridge, ipcRenderer, webFrame } from "electron";
import type { OpenedbotNativeBridge } from "../shared/bridge";
import { CHANNEL } from "./channels";
import { createNativeAuthBridge } from "./native-auth";
import { wireSigninPage } from "./signin-page";

// The main process passes its app version on the renderer command line
// (webPreferences.additionalArguments): no synchronous IPC needed at preload time.
function shellVersion(): string {
  const prefix = "--openedbot-shell-version=";
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? "0.0.0";
}

// Where the preload runs: the local sign-in page (file:, the fallback) or the
// remote console, signed in or on its /login.
// The main process re-checks the sender of every message; this split only
// avoids exposing the bridge to a page that has no business with it.
if (window.location.protocol === "file:") {
  wireSigninPage();
} else {
  // Contract in src/shared/bridge.ts: the four calls are frozen, `auth` is
  // optional (a console checks it before use). The refresh token stays in the
  // main process: nothing here can read it, and no channel returns it.
  const bridge: OpenedbotNativeBridge = {
    readAccessToken: () => ipcRenderer.invoke(CHANNEL.readAccessToken) as Promise<string | null>,
    refresh: () => ipcRenderer.invoke(CHANNEL.refresh) as Promise<string | null>,
    openExternal: (url) => ipcRenderer.invoke(CHANNEL.openExternal, url) as Promise<void>,
    signOut: () => ipcRenderer.invoke(CHANNEL.signOut) as Promise<void>,
    shell: { platform: "windows", version: shellVersion() },
    auth: createNativeAuthBridge(),
  };
  contextBridge.exposeInMainWorld("__OPENEDBOT_NATIVE__", bridge);
}

// Observe the existing theme attributes instead of extending the frozen public bridge.
// Send the requested mode, not the resolved colour: forcing dark for "system"
// would override prefers-color-scheme and prevent subsequent OS changes.
window.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  let lastMode: string | null = null;
  const sync = (): void => {
    const requested = root.dataset.themeMode ?? root.dataset.theme;
    const mode = requested === "light" || requested === "dark" ? requested : "system";
    if (mode === lastMode) return;
    lastMode = mode;
    void ipcRenderer.invoke(CHANNEL.theme, mode).catch(() => {
      lastMode = null;
    });
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { attributes: true, attributeFilter: ["data-theme-mode", "data-theme"] });
  sync();
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
});

// The console's text size (Réglages › Apparence, ../.. apps/console/src/lib/shell/text-size.ts)
// zooms the whole window, read from `<html data-openedbot-text-zoom>` like the theme
// above, without extending the frozen bridge. Applied here first
// (webFrame, before the page paints at 100 %), then told to the main process,
// which keeps it for View › Actual Size and lines the system buttons up with
// the zoomed top bar. Once applied, `data-native-zoom` and `--openedbot-native-zoom`
// tell the console's CSS (its own settings-modal zoom steps aside, the room
// kept for the traffic lights follows). Mirror of TEXT_ZOOM_FACTORS
// (src/shared/bridge.ts): a sandboxed preload cannot import it.
const TEXT_ZOOM_FACTORS = [10, 11, 12, 13, 14].map((size) => size / 14);
if (window.location.protocol !== "file:") {
  // Before the page paints: the size the main process kept from the last
  // page (and across launches). A reload used to paint the console's boot
  // silhouette at 100 %, then jump to the chosen size once its JavaScript
  // had run. The page's own attribute, read below, stays the source of truth.
  let initialZoom: unknown = null;
  try {
    initialZoom = ipcRenderer.sendSync(CHANNEL.textZoomInitial);
  } catch {
    initialZoom = null;
  }
  if (typeof initialZoom === "number" && TEXT_ZOOM_FACTORS.includes(initialZoom)) webFrame.setZoomFactor(initialZoom);
  window.addEventListener("DOMContentLoaded", () => {
    const root = document.documentElement;
    let lastZoom: number | null = null;
    const clear = (): void => {
      root.removeAttribute("data-native-zoom");
      root.style.removeProperty("--openedbot-native-zoom");
    };
    const sync = (): void => {
      const zoom = Number(root.getAttribute("data-openedbot-text-zoom"));
      if (!TEXT_ZOOM_FACTORS.includes(zoom)) {
        lastZoom = null;
        clear();
        webFrame.setZoomFactor(1);
        return;
      }
      if (zoom === lastZoom) return;
      lastZoom = zoom;
      webFrame.setZoomFactor(zoom);
      root.setAttribute("data-native-zoom", "");
      root.style.setProperty("--openedbot-native-zoom", String(zoom));
      void ipcRenderer.invoke(CHANNEL.textZoom, zoom).catch(() => {
        // The page stays zoomed (webFrame); only Actual Size and the system
        // buttons' position miss the change. Retried on the next change.
        lastZoom = null;
      });
    };
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-openedbot-text-zoom"] });
    sync();
    window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  });
}