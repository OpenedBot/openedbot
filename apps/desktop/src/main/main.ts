import "./env-aliases-apply"; // first: OHB_* -> OPENEDBOT_* fallback
import { app, dialog, Menu } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAuthService, type AuthService } from "./auth";
import { getConfig } from "./config";
import { setupDeepLink } from "./deep-link";
import { closeDiagnostics, openDiagnostics } from "./diagnostics";
import { isElectronViteDev, reloadOnChange } from "./dev-reload";
import { registerIpc } from "./ipc";
import { log } from "./log";
import { createPopupHost, locatePopupBundle, type PopupGiveUpReason, type PopupHost } from "./popup-host";
import { loadPreferences, savePreferences, type DisplayMode } from "./preferences";
import { registerShortcuts, unregisterShortcuts } from "./shortcuts";
import { devUserDataName, targetLabel } from "./target";
import { createTray, type ShellTray } from "./tray";
import { createShellWindow, type ShellWindow } from "./window";

// No product logic lives here: this process only hosts the console in a native
// window, owns the OAuth session, and exposes it through a minimal bridge.

function start(): void {
  // After the lock: only the instance that owns userData writes its journal.
  openDiagnostics(
    path.join(app.getPath("userData"), "diagnostics.sqlite"),
    `openedbot ${app.getVersion()}, Electron ${process.versions.electron}, ${process.platform} ${process.arch}${app.isPackaged ? "" : ", dev"}`,
  );
  let shellWindow: ShellWindow | null = null;
  let tray: ShellTray | null = null;
  let auth: AuthService | null = null;
  let popupHost: PopupHost | null = null;
  let stopLoopback = (): void => {};

  // The window dies with the app, never on its own: the tray keeps it alive.
  app.on("window-all-closed", () => {});

  app.on("web-contents-created", (_event, contents) => {
    // The console has no business embedding <webview>; refuse it outright.
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  // A second launch (Start menu, or the OS handing us an ohb:// URL on Windows)
  // lands here instead of opening a second window.
  let handleCommandLine = (_argv: readonly string[]): void => {};
  app.on("second-instance", (_event, argv) => {
    shellWindow?.bringToFront();
    handleCommandLine(argv);
  });

  app.on("before-quit", () => {
    // Closing its stdin is enough: the popup quits on EOF (and would on our exit anyway).
    popupHost?.stop();
    shellWindow?.allowClose();
    auth?.dispose();
    stopLoopback();
  });
  app.on("will-quit", () => {
    unregisterShortcuts();
    tray?.destroy();
    closeDiagnostics();
  });

  // macOS: a Dock click on a hidden window brings it back, like any Mac app.
  app.on("activate", () => shellWindow?.show());

  // Windows: the identity of the taskbar group, the toast notifications and the
  // Start menu shortcut (electron-builder's NSIS uses the appId). A dev run gets
  // its own, so it never merges with an installed openedbot on the taskbar. Before ready.
  if (process.platform === "win32") app.setAppUserModelId(isElectronViteDev ? "app.openedbot.desktop.dev" : "app.openedbot.desktop");

  void app.whenReady().then(() => {
    // Windows needs no menu bar in a release. macOS needs the standard menus:
    // without the Edit menu, Cmd+C / Cmd+V / Cmd+A never reach the page's text
    // fields; without View, Cmd+= / Cmd+- / Cmd+0 do not zoom. No Reload outside
    // `make dev`: Cmd+R would drop a half-typed message for nothing. A dev run
    // elsewhere gets a hidden View menu (the window has no visible menu bar):
    // its accelerators give Ctrl+R and Ctrl+Shift+I (DevTools).
    Menu.setApplicationMenu(
      process.platform === "darwin"
        ? Menu.buildFromTemplate([
            { role: "appMenu" },
            { role: "editMenu" },
            {
              label: "View",
              submenu: [
                ...(isElectronViteDev
                  ? [{ role: "reload" as const }, { role: "toggleDevTools" as const }, { type: "separator" as const }]
                  : []),
                // Back to the console's text size (Apparence), not to 100 %.
                { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => shellWindow?.resetZoom() },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
              ],
            },
            { role: "windowMenu" },
          ])
        : isElectronViteDev
          ? Menu.buildFromTemplate([{ role: "editMenu" }, { role: "viewMenu" }])
          : null,
    );

    let config;
    try {
      config = getConfig();
    } catch (error) {
      dialog.showErrorBox("openedbot", `Configuration invalide : ${error instanceof Error ? error.message : "erreur inconnue"}`);
      app.exit(1);
      return;
    }

    // A shell that is not aimed at production says so, packaged or not: in the
    // window title and the tray tooltip, so a release is never silently off production.
    const label = targetLabel(config.apiOrigin);
    if (label) log.warn("aimed at a non-production API");

    const onBrowserReturn = (): void => {
      // The claim by polling is what authenticates; the callback only means the
      // browser step is over, so poll right away and bring the window back.
      shellWindow?.bringToFront();
      auth?.nudge();
    };
    const deepLink = setupDeepLink(onBrowserReturn);
    handleCommandLine = (argv) => deepLink.handleCommandLine(argv);
    stopLoopback = () => deepLink.stopLoopback();

    const signinPath = path.join(app.getAppPath(), "src", "renderer", "signin.html");
    const iconPath = path.join(app.getAppPath(), "src", "renderer", "icon.png");
    // Windows takes the window icon; an unpackaged run on a Mac dev box would
    // otherwise show the stock Electron icon in the Dock.
    app.dock?.setIcon(iconPath);

    const service = createAuthService({
      config,
      redirectUri: deepLink.redirectUri,
      startLoopback: () => deepLink.startLoopback(),
      stopLoopback: () => deepLink.stopLoopback(),
      events: {
        onSignedIn: () => {
          shellWindow?.loadConsole();
          shellWindow?.bringToFront();
          popupHost?.notifySignedIn();
          tray?.refresh();
        },
        onSignedOut: (reason) => {
          void shellWindow?.showSigninAndClearStorage();
          shellWindow?.sendSigninState({ status: "idle", reason });
          // Signing in happens in the window, whatever the display mode.
          if (!shellWindow?.isVisible()) shellWindow?.bringToFront();
          popupHost?.notifySignedOut();
          tray?.refresh();
        },
        onSigninState: (state) => shellWindow?.sendSigninState(state),
      },
    });
    auth = service;
    const restored = service.restore();

    // The popup is the native openedbot Notch, macOS only for now: Windows stays a
    // window whatever preferences.json says.
    const preferences = loadPreferences();
    const popupSupported = process.platform === "darwin";
    let displayMode: DisplayMode = popupSupported ? preferences.displayMode : "window";

    // Popup-only mode: no Dock icon while the window is hidden, back as soon as
    // it shows (openConsole, the shortcut, a second launch, signing in).
    const syncDock = (windowVisible: boolean): void => {
      if (!app.dock) return;
      if (displayMode === "popup" && !windowVisible) {
        app.dock.hide();
      } else if (!app.dock.isVisible()) {
        // A window shown while the app had no Dock icon may not take focus or
        // the menu bar: show it again once the Dock icon is back.
        void app.dock.show().then(() => {
          if (shellWindow?.isVisible()) shellWindow.show();
        });
      }
    };

    const window = createShellWindow({
      config,
      preloadPath: path.join(__dirname, "..", "preload", "preload.js"),
      signinPath,
      iconPath,
      onAlwaysOnTopChange: () => tray?.refresh(),
      startHidden: displayMode === "popup" && restored,
      onVisibilityChange: (visible) => syncDock(visible),
      onConsoleWithoutBridge: () => {
        // Keep the session: the tokens are fine, the console is not. Showing
        // its landing would lead to a web login that ends in the browser.
        log.warn("console never called the bridge: it predates native support");
        window.showSignin();
        const host = new URL(config.consoleUrl).host;
        window.sendSigninState({
          status: "error",
          code: "CONSOLE_UNSUPPORTED",
          params: { host },
          message: `La console ${host} ne prend pas encore en charge l’application de bureau : elle ignore la session de l’app. Visez une console à jour (OPENEDBOT_CONSOLE_URL ou config.json).`,
        });
      },
    });
    shellWindow = window;

    const setDisplayMode = (mode: DisplayMode): void => {
      displayMode = popupSupported ? mode : "window";
      preferences.displayMode = displayMode;
      savePreferences(preferences);
      if (displayMode === "window") popupHost?.stop();
      else popupHost?.start();
      // Popup only hides the window, unless there is no session to show in the popup.
      if (displayMode === "popup" && service.isSignedIn()) window.hide();
      else window.show();
      syncDock(window.isVisible());
      tray?.refresh();
    };

    const host = createPopupHost({
      config,
      auth: service,
      onOpenConsole: (url) => {
        if (service.isSignedIn()) window.loadConsole(url);
        window.bringToFront();
      },
      onGiveUp: (reason) => {
        setDisplayMode("window");
        void dialog.showMessageBox({ type: "warning", message: "Popup désactivée", detail: popupGiveUpMessage(reason) });
      },
      onUserClosed: () => setDisplayMode("window"),
    });
    popupHost = host;

    tray = createTray({
      window,
      targetLabel: label,
      isSignedIn: () => service.isSignedIn(),
      onSignOut: () => service.signOut(),
      onQuit: () => app.quit(),
      displayMode: popupSupported
        ? { current: () => displayMode, popupAvailable: () => locatePopupBundle() !== null, set: setDisplayMode }
        : undefined,
    });

    registerShortcuts(() => window.toggle());
    registerIpc({
      auth: service,
      config,
      signinUrl: pathToFileURL(signinPath).href,
      onBridgeUse: () => window.noteBridgeUse(),
      onTextZoom: (factor) => window.setTextZoom(factor),
      initialTextZoom: () => window.initialTextZoom(),
    });

    if (restored) window.loadConsole();
    else window.showSignin();
    if (displayMode !== "window") host.start();
    syncDock(!(displayMode === "popup" && restored));

    if (isElectronViteDev) {
      reloadOnChange([path.join(__dirname, "..", "preload"), path.join(app.getAppPath(), "src", "renderer")], () => window.reload());
    }

    // Cold start through an ohb:// link (Windows passes it in argv).
    deepLink.handleCommandLine(process.argv);
    log.info(`ready, console ${config.consoleUrl}`);
  });
}

function popupGiveUpMessage(reason: PopupGiveUpReason): string {
  switch (reason.kind) {
    case "missing":
      return "openedbot notch n’est pas embarquée dans cette version d’openedbot. openedbot repasse en mode Fenêtre.";
    case "crashing":
      return `La popup s’est arrêtée ${reason.failures} fois de suite. openedbot repasse en mode Fenêtre.`;
    case "protocol":
      return reason.version === 0
        ? "Cette version d’openedbot notch est antérieure au mode popup d’openedbot : reconstruisez-la (make bundle dans openedbot-notch). openedbot repasse en mode Fenêtre."
        : `Cette popup parle une autre version du protocole (${reason.version}). openedbot repasse en mode Fenêtre.`;
    case "fatal":
      return reason.code === "STANDALONE_RUNNING"
        ? "openedbot notch tourne déjà seule. Quittez-la, puis choisissez à nouveau Popup dans le menu du Dock."
        : `La popup a refusé de démarrer (${reason.code}). openedbot repasse en mode Fenêtre.`;
  }
}

// electron-vite dev restarts the app by killing it and spawning the new build
// at once, without waiting for the old process to exit: the new one can find
// the lock still held. Only then, wait for it to be released instead of quitting.
const DEV_LOCK_ATTEMPTS = 30;
const DEV_LOCK_RETRY_MS = 100;

// A dev run talks to the dev console (config.ts) and must not share the
// installed app's userData: it would refresh the production session against
// the dev API, take the 401 and wipe the real tokens. Before the lock, which
// is scoped to userData, and before anything reads that directory. Each
// backend a dev run can aim at (production or any other API) gets its
// own folder (`devUserDataName`), so switching target never signs the
// developer out. getConfig() cannot decide here (it reads userData), the
// environment can.
if (isElectronViteDev) {
  app.setPath("userData", path.join(app.getPath("appData"), devUserDataName(process.env)));
}

// Dev only: a Chrome DevTools Protocol endpoint on loopback, so tools
// (chrome-devtools-mcp, Playwright `connectOverCDP`, a raw CDP script) can
// drive the real window: read the DOM, click, take screenshots. Never in a
// packaged build, where any local process could use it to read the session
// through the bridge. Must be set before `ready`.
if (isElectronViteDev) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.OPENEDBOT_REMOTE_DEBUGGING_PORT ?? "9333");
}

// The console's copy buttons use navigator.clipboard, which Chromium only
// exposes in a secure context. A lab console on plain http (the dev PC's Vite
// servers, http://<dev-pc>:1420 and :1421) is not one, so every "Copy" did
// nothing (seen 2026-10-22 on the pairing ticket). Treat exactly that origin
// as secure: config.ts accepts http for loopback and LAN hosts only, and the
// window never navigates off the console origin. Must be set before `ready`.
try {
  const consoleUrl = new URL(getConfig().consoleUrl);
  if (consoleUrl.protocol === "http:") app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", consoleUrl.origin);
} catch {
  // An invalid setting is reported by start(), with its dialog.
}

// Only one shell may own the tray icon, the global shortcut and the token file.
function acquireLock(attemptsLeft: number): void {
  if (app.requestSingleInstanceLock()) start();
  else if (isElectronViteDev && attemptsLeft > 0) setTimeout(() => acquireLock(attemptsLeft - 1), DEV_LOCK_RETRY_MS);
  else app.quit();
}
acquireLock(DEV_LOCK_ATTEMPTS);
