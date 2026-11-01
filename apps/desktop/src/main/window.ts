import { app, BrowserWindow, nativeTheme, screen, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SigninState } from "../shared/bridge";
import { consoleOrigins, isProductionApi, type DesktopConfig } from "./config";
import { installContextMenu } from "./context-menu";
import { pathOnly, recordDiagnostic } from "./diagnostics";
import { log } from "./log";
import { loadPreferences, savePreferences } from "./preferences";
import { targetLabel } from "./target";

// The full console (sidebar, thread, settings) needs a desktop-sized window.
// The first launch takes a share of the screen rather than a fixed size: a
// fixed 1280x820 filled a quarter of a 2560x1440 monitor (operator's call,
// 2026-10-22). Never below that former size, never past the work area.
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 820;
const WINDOW_WIDTH_SHARE = 0.75;
const WINDOW_HEIGHT_SHARE = 0.8;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 560;
const SCREEN_MARGIN = 16;
const RELOAD_DELAY_MS = 5_000;
// ERR_ABORTED: a navigation superseded by another one, not a failure.
const ERR_ABORTED = -3;
// A console that supports the shell asks the bridge for the token before its
// first API call, right after load. Silence past this delay means a console
// without native support (an older deploy): it would show its public landing
// and web login, whose Google step ends in the system browser, not here.
const BRIDGE_PROBE_MS = 10_000;
// The console's frame surface (BoardUI `--bui-background-full`: light #ffffff,
// dark #121212), the colour of its top bar, around the grey cards of BoardUI's
// "Chat Starter" template (sidebar and main card). Painted before the first frame so a launch never flashes white in dark
// mode (OpenBot does the same), and behind the Windows caption buttons so they
// melt into the console's top bar.
const FRAME_RGB = { light: [255, 255, 255], dark: [18, 18, 18] } as const;
// The caption glyphs: the console's primary text on that surface.
const CAPTION_SYMBOL = { light: "#18181b", dark: "#ececec" } as const;
// The console's top bar (../.. board-chrome.tsx, 46 px): the macOS traffic
// lights are centred on it, the Windows caption buttons are exactly as tall.
const TITLE_BAR_HEIGHT = 46;
const isWindows = process.platform === "win32";

const themeKey = (): "light" | "dark" => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
const backgroundColor = (): string => `#${FRAME_RGB[themeKey()].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

// Windows: the min / max / close buttons Electron draws over the top right
// corner of the page (titleBarOverlay). On the console they take the frame
// colour, so the top bar reads as one surface up to the window edge. The
// sign-in templates paint their own backgrounds (art, gradients) there, so
// the buttons go transparent: the frame colour with alpha 0, which degrades
// to the plain frame colour if a Windows build ever ignored the alpha. Hover
// and close-red are drawn by Electron either way.
// `zoom`: the console's text size zooms the page, so its top bar is
// 46 x zoom screen pixels high; the buttons keep the bar's height.
function titleBarOverlay(view: "console" | "signin", zoom: number): Electron.TitleBarOverlayOptions {
  const [r, g, b] = FRAME_RGB[themeKey()];
  return {
    color: `rgba(${r}, ${g}, ${b}, ${view === "signin" ? 0 : 1})`,
    symbolColor: CAPTION_SYMBOL[themeKey()],
    height: Math.round(TITLE_BAR_HEIGHT * zoom),
  };
}

// macOS: the 14 pt traffic lights centred on the top bar, 46 x zoom screen
// pixels high ({16, 16} at 100 %: centre y 23). They do not zoom with the
// page; native-titlebar.css reserves their width in page pixels.
const trafficLightPosition = (zoom: number): Electron.Point => ({ x: 16, y: Math.round((TITLE_BAR_HEIGHT * zoom) / 2 - 7) });

export type ShellWindow = {
  show(): void;
  hide(): void;
  toggle(): void;
  isVisible(): boolean;
  /** Raises the window above others even when stay-on-top is off (deep link return). */
  bringToFront(): void;
  /** Loads the console home, or `url` (a console URL already validated by the caller). */
  loadConsole(url?: string): void;
  /** The console called the bridge: it supports the shell. */
  noteBridgeUse(): void;
  /** The console's text size, as a page zoom factor (validated by ipc.ts). */
  setTextZoom(factor: number): void;
  /** The zoom the console's next page starts with (its last text size, kept across launches). */
  initialTextZoom(): number;
  /** View › Actual Size: back to the text size's zoom, not to 100 %. */
  resetZoom(): void;
  showSignin(): void;
  /** Unloads the console and clears its cached account data on sign-out. */
  showSigninAndClearStorage(): Promise<void>;
  sendSigninState(state: SigninState): void;
  isAlwaysOnTop(): boolean;
  setAlwaysOnTop(value: boolean): void;
  /** After this, closing the window really closes it instead of hiding it to the tray. */
  allowClose(): void;
  /** Reloads the current page, bypassing the cache (make dev only). */
  reload(): void;
};

export type ShellWindowOptions = {
  config: DesktopConfig;
  preloadPath: string;
  signinPath: string;
  /** Window and taskbar icon (PNG). */
  iconPath: string;
  /** Fired when stay-on-top changes so the tray checkbox can follow. */
  onAlwaysOnTopChange(value: boolean): void;
  /** The loaded console never touched the bridge (see BRIDGE_PROBE_MS). */
  onConsoleWithoutBridge(): void;
  /** Popup-only mode with a session: the window stays hidden at launch. */
  startHidden?: boolean;
  /** Fired on show and hide (close included), so the Dock icon can follow in popup-only mode. */
  onVisibilityChange?(visible: boolean): void;
};

// The last bounds when they still land on a connected display (a laptop
// unplugged from its monitor must not reopen off-screen), otherwise centred on
// the primary display's work area, clamped for small screens.
function initialBounds(saved: Electron.Rectangle | null): Electron.Rectangle {
  if (saved && saved.width >= MIN_WIDTH && saved.height >= MIN_HEIGHT) {
    const area = screen.getDisplayMatching(saved).workArea;
    const visible =
      saved.x < area.x + area.width - SCREEN_MARGIN &&
      saved.x + saved.width > area.x + SCREEN_MARGIN &&
      saved.y >= area.y - SCREEN_MARGIN &&
      saved.y < area.y + area.height - SCREEN_MARGIN;
    if (visible) return saved;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(WINDOW_WIDTH, Math.round(area.width * WINDOW_WIDTH_SHARE)), area.width - 2 * SCREEN_MARGIN);
  const height = Math.min(Math.max(WINDOW_HEIGHT, Math.round(area.height * WINDOW_HEIGHT_SHARE)), area.height - 2 * SCREEN_MARGIN);
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

// Only web links go to the OS: file:, ms-settings:, custom schemes and the like
// would let a page launch arbitrary local handlers.
function openInSystemBrowser(raw: string): void {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") void shell.openExternal(url.toString());
  } catch {
    // Not a URL: nothing to open.
  }
}

// What the window tells the diagnostics journal (diagnostics.ts): the page's
// console warnings and errors, the API and console answers >= 400 and the
// requests that never got one, failed loads and renderer crashes. Paths only:
// a query can carry an OAuth code, a header a token.
function recordWindowDiagnostics(contents: Electron.WebContents, origins: readonly string[]): void {
  const watched = (url: string): boolean => origins.some((origin) => url.startsWith(`${origin}/`));

  contents.on("console-message", (event) => {
    if (event.level !== "warning" && event.level !== "error") return;
    recordDiagnostic(event.level === "error" ? "error" : "warn", "page", event.message, `${pathOnly(event.sourceId)}:${event.lineNumber}`);
  });

  contents.session.webRequest.onCompleted((details) => {
    if (details.statusCode < 400 || !watched(details.url)) return;
    recordDiagnostic(
      details.statusCode >= 500 ? "error" : "warn",
      "http",
      `${details.method} ${new URL(details.url).pathname} ${details.statusCode}`,
      `${details.resourceType}${details.fromCache ? ", from cache" : ""}`,
    );
  });

  // ERR_ABORTED is a navigation or a stream the page closed itself: noise.
  contents.session.webRequest.onErrorOccurred((details) => {
    if (details.error === "net::ERR_ABORTED" || !watched(details.url)) return;
    recordDiagnostic("error", "http", `${details.method} ${new URL(details.url).pathname} ${details.error}`, details.resourceType);
  });

  contents.on("did-fail-load", (_event, errorCode, description, validatedUrl, isMainFrame) => {
    if (errorCode === ERR_ABORTED) return;
    recordDiagnostic(isMainFrame ? "error" : "warn", "load", `${description} (${errorCode})`, pathOnly(validatedUrl));
  });

  contents.on("render-process-gone", (_event, details) => {
    recordDiagnostic(details.reason === "clean-exit" ? "warn" : "error", "renderer", `renderer gone: ${details.reason}`, `exit code ${details.exitCode}`);
  });

  contents.on("unresponsive", () => recordDiagnostic("warn", "renderer", "page unresponsive"));
}

export function createShellWindow(options: ShellWindowOptions): ShellWindow {
  const { config } = options;
  // The configured console plus, for production, its former apex origin (target.ts).
  const trustedOrigins = consoleOrigins(config);
  const signinUrl = pathToFileURL(options.signinPath).href;
  // The page loads its template stylesheet from the query (the preload adds
  // the <link>); an unknown name falls back to the default rather than to an
  // unstyled page.
  const templatesDir = path.join(path.dirname(options.signinPath), "templates");
  const template = existsSync(path.join(templatesDir, `${config.signinTemplate}.css`)) ? config.signinTemplate : "console-split";
  if (template !== config.signinTemplate) log.warn(`sign-in template "${config.signinTemplate}" not found, using ${template}`);
  const isSigninUrl = (url: string): boolean => url.split(/[?#]/)[0] === signinUrl;
  const appUrl = `${config.consoleUrl}/`;
  const preferences = loadPreferences();

  let closeForReal = false;
  let view: "console" | "signin" = "console";
  let lastSigninState: SigninState = { status: "idle" };
  let reloadTimer: NodeJS.Timeout | null = null;
  let bridgeUsed = false;
  let bridgeProbe: NodeJS.Timeout | null = null;
  const clearBridgeProbe = (): void => {
    if (bridgeProbe) clearTimeout(bridgeProbe);
    bridgeProbe = null;
  };

  const win = new BrowserWindow({
    ...initialBounds(preferences.bounds),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: "openedbot",
    icon: options.iconPath,
    autoHideMenuBar: true,
    alwaysOnTop: preferences.alwaysOnTop,
    // No separate title bar on either platform: the page runs up to the top
    // edge and the console's 46 px top bar is the window's title bar, as in
    // Codex. The page draws the drag handle and keeps clear of the system
    // buttons itself: ../.. apps/console/src/styles/components/native-titlebar.css
    // and src/renderer/signin-base.css. Change all three together.
    // - macOS: the traffic lights float over the top left corner. "hidden"
    //   rather than "hiddenInset": the inset is fixed by the OS, while the
    //   console's top bar is not at the OS's height. {16, 16} puts the 14 pt
    //   buttons at x 16-76, y 16-30, centred on the bar (46 / 2 = 23).
    // - Windows: Electron draws min / max / close over the top right corner
    //   at the bar's height (titleBarOverlay, colours above). Requested by
    //   the operator on 2026-10-13, replacing the native white title bar.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: trafficLightPosition(1) }
      : isWindows
        ? { titleBarStyle: "hidden" as const, titleBarOverlay: titleBarOverlay("console", 1) }
        : {}),
    backgroundColor: backgroundColor(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      additionalArguments: [`--ohb-shell-version=${app.getVersion()}`],
    },
  });

  const contents = win.webContents;
  // Off production, the page title would hide where the window points: keep the
  // backend in the title (taskbar, Alt+Tab).
  const label = targetLabel(config.apiOrigin);
  if (label) {
    win.setTitle(`openedbot (${label})`);
    win.on("page-title-updated", (event, title) => {
      event.preventDefault();
      win.setTitle(`${title} (${label})`);
    });
  }
  recordWindowDiagnostics(contents, [...trustedOrigins, config.apiOrigin]);

  // The console is also a PWA: its service worker precaches one build and
  // keeps serving it after a deploy until it updates itself. A desktop shell
  // is always online and must open the deployed console, not a stale copy
  // that predates the bridge (seen 2026-10-10: the old bundle came back from
  // CacheStorage after the deploy). Cleared once per launch, before any load.
  const storageCleared = contents.session
    .clearStorageData({ storages: ["serviceworkers", "cachestorage"] })
    .catch((error: unknown) => log.warn(`could not clear the service worker cache (${error instanceof Error ? error.message : "error"})`));

  // The window is the whole product: closing it parks the app in the tray.
  win.on("close", (event) => {
    // Remembered on every close (hide included): a crash later keeps the last placement.
    if (!win.isMinimized() && !win.isFullScreen()) {
      preferences.bounds = win.getNormalBounds();
      savePreferences(preferences);
    }
    if (closeForReal) return;
    event.preventDefault();
    win.hide();
  });
  win.once("ready-to-show", () => {
    if (!options.startHidden) win.show();
  });
  win.on("show", () => options.onVisibilityChange?.(true));
  win.on("hide", () => options.onVisibilityChange?.(false));

  // Deny every permission except, for the console itself, notifications and
  // writing to the clipboard (its "copy" buttons: navigator.clipboard.writeText
  // asks for clipboard-sanitized-write). Reading the clipboard, the camera,
  // the microphone and the rest stay refused.
  const CONSOLE_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);
  const isConsoleOrigin = (url: string): boolean => {
    try {
      return trustedOrigins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  };
  contents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(CONSOLE_PERMISSIONS.has(permission) && isConsoleOrigin(details.requestingUrl));
  });
  contents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return CONSOLE_PERMISSIONS.has(permission) && trustedOrigins.includes(requestingOrigin);
  });

  contents.setWindowOpenHandler(({ url }) => {
    openInSystemBrowser(url);
    return { action: "deny" };
  });

  // Right click: copy, paste and spelling, on the console and the sign-in page.
  installContextMenu(contents);

  // Keeps the shell on the console (or its own sign-in page). Anything else is
  // handed to the system browser: the window must never become a general
  // purpose browser with the bridge exposed.
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isSigninUrl(url) || isConsoleOrigin(url)) return;
    event.preventDefault();
    if (view === "console") openInSystemBrowser(url);
  };
  contents.on("will-navigate", (event, url) => guardNavigation(event, url));
  contents.on("will-redirect", (event, url) => guardNavigation(event, url));

  contents.on("did-finish-load", () => {
    if (view === "signin") contents.send("auth:state", lastSigninState);
    if (view !== "console" || bridgeUsed) return;
    clearBridgeProbe();
    bridgeProbe = setTimeout(() => {
      bridgeProbe = null;
      if (view === "console" && !bridgeUsed && !win.isDestroyed()) options.onConsoleWithoutBridge();
    }, BRIDGE_PROBE_MS);
  });

  // The caption buttons follow the theme (nativeTheme follows the page
  // through "ohb:theme") and the view (solid on the console, see-through on
  // the sign-in page).
  // Réglages › Apparence › Taille du texte of the console, sent by the
  // preload ("ohb:text-zoom"). The sign-in page keeps 100 %.
  let textZoom = preferences.textZoom;
  const viewZoom = (): number => (view === "console" ? textZoom : 1);
  const repaintCaptionButtons = (): void => {
    if (win.isDestroyed()) return;
    if (isWindows) win.setTitleBarOverlay(titleBarOverlay(view, viewZoom()));
    if (process.platform === "darwin") win.setWindowButtonPosition(trafficLightPosition(viewZoom()));
  };
  const repaintBackground = (): void => {
    if (win.isDestroyed()) return;
    win.setBackgroundColor(backgroundColor());
    repaintCaptionButtons();
  };
  nativeTheme.on("updated", repaintBackground);
  win.on("closed", () => nativeTheme.off("updated", repaintBackground));

  let signedOutStorageCleared: Promise<void> = Promise.resolve();
  const loadSignin = async (): Promise<void> => {
    view = "signin";
    clearBridgeProbe();
    repaintCaptionButtons();
    try {
      // `password=off`: production starts without the e-mail form, so it never
      // flashes before the providers answer (signin-context.ts has the rule).
      const query: Record<string, string> = isProductionApi(config) ? { template, password: "off" } : { template };
      await contents.loadFile(options.signinPath, { query });
    } catch (error) {
      log.warn(`could not load the sign-in page (${error instanceof Error ? error.message : "error"})`);
    }
  };
  const showSigninAndClearStorage = (): Promise<void> => {
    signedOutStorageCleared = (async () => {
      // Electron's storage API has no per-key localStorage deletion. Remove
      // only this account-derived shape while the console origin is loaded.
      if (!contents.isDestroyed() && !contents.isLoading() && isConsoleOrigin(contents.getURL())) {
        try {
          await contents.executeJavaScript(`if (${JSON.stringify(trustedOrigins)}.includes(location.origin)) localStorage.removeItem("ohb:boot-sidebar");`);
        } catch (error) {
          log.warn(`could not clear the boot sidebar (${error instanceof Error ? error.message : "error"})`);
        }
      } else {
        log.warn("boot sidebar cleanup skipped: console origin is not ready");
      }
      // Unload the old persister before deletion so it cannot repopulate the
      // database. A subsequent sign-in waits for this cleanup in loadConsole.
      await loadSignin();
      try {
        for (const origin of trustedOrigins) await contents.session.clearStorageData({ origin, storages: ["indexdb"] });
      } catch (error) {
        log.warn(`could not clear the console query cache (${error instanceof Error ? error.message : "error"})`);
      }
    })();
    return signedOutStorageCleared;
  };

  // Offline at launch or a deploy in progress: keep retrying instead of
  // leaving a blank window with no way to recover but quitting.
  contents.on("did-fail-load", (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED || view !== "console" || !isConsoleOrigin(validatedUrl)) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (view === "console" && !win.isDestroyed()) void contents.loadURL(appUrl);
    }, RELOAD_DELAY_MS);
  });

  const api: ShellWindow = {
    show(): void {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },

    hide: () => win.hide(),

    // Visible means hide, whatever the focus: a tray click steals focus before
    // we run, so a focus test would make the tray unable to ever hide it.
    toggle(): void {
      if (win.isVisible() && !win.isMinimized()) api.hide();
      else api.show();
    },

    isVisible: () => win.isVisible(),

    bringToFront(): void {
      // Windows refuses focus theft from a background process; a momentary
      // always-on-top raise is the reliable way to surface the window.
      const stayOnTop = win.isAlwaysOnTop();
      if (!stayOnTop) win.setAlwaysOnTop(true);
      api.show();
      if (!stayOnTop) win.setAlwaysOnTop(false);
    },

    loadConsole(url?: string): void {
      view = "console";
      bridgeUsed = false;
      repaintCaptionButtons();
      void Promise.all([storageCleared, signedOutStorageCleared]).then(() => {
        if (view === "console" && !win.isDestroyed()) void contents.loadURL(url ?? appUrl);
      });
    },

    noteBridgeUse(): void {
      bridgeUsed = true;
      clearBridgeProbe();
    },

    showSignin(): void {
      void loadSignin();
    },

    showSigninAndClearStorage,

    sendSigninState(state: SigninState): void {
      lastSigninState = state;
      if (view === "signin" && !contents.isLoading()) contents.send("auth:state", state);
    },

    isAlwaysOnTop: () => win.isAlwaysOnTop(),

    setAlwaysOnTop(value: boolean): void {
      win.setAlwaysOnTop(value);
      preferences.alwaysOnTop = value;
      savePreferences(preferences);
      options.onAlwaysOnTopChange(value);
    },

    reload(): void {
      if (!win.isDestroyed()) contents.reloadIgnoringCache();
    },

    setTextZoom(factor: number): void {
      if (factor !== preferences.textZoom) {
        preferences.textZoom = factor;
        savePreferences(preferences);
      }
      textZoom = factor;
      if (win.isDestroyed()) return;
      if (view === "console") contents.setZoomFactor(factor);
      repaintCaptionButtons();
    },

    initialTextZoom: () => textZoom,

    resetZoom(): void {
      if (!win.isDestroyed()) contents.setZoomFactor(viewZoom());
    },

    allowClose(): void {
      closeForReal = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      clearBridgeProbe();
    },
  };

  return api;
}
