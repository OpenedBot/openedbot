import { afterAll, beforeEach, expect, jest, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Every step the window takes, in order: loads, storage clears, pushes.
let steps: string[] = [];
const userData = mkdtempSync(path.join(tmpdir(), "ohb-window-test-"));

class FakeContents extends EventEmitter {
  url = "";
  session = {
    clearStorageData: async (options?: { origin?: string; storages?: string[] }) => {
      steps.push(`clear ${options?.storages?.join(",") ?? ""}${options?.origin ? ` ${options.origin}` : ""}`);
    },
    webRequest: { onCompleted: () => {}, onErrorOccurred: () => {} },
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
  };
  setWindowOpenHandler(): void {}
  async loadURL(url: string): Promise<void> {
    steps.push(`load ${url}`);
    this.url = url;
  }
  async loadFile(file: string, options?: { query?: Record<string, string> }): Promise<void> {
    steps.push(`file ${path.basename(file)}`);
    this.url = `${pathToFileURL(file).href}?${new URLSearchParams(options?.query).toString()}`;
  }
  getURL(): string {
    return this.url;
  }
  isLoading(): boolean {
    return false;
  }
  isDestroyed(): boolean {
    return false;
  }
  async executeJavaScript(): Promise<void> {
    steps.push("localStorage cleanup");
  }
  send(channel: string, payload: { status: string }): void {
    steps.push(`send ${channel} ${payload.status}`);
  }
  setZoomFactor(): void {}
  reloadIgnoringCache(): void {}
}

let contents: FakeContents;

class FakeBrowserWindow extends EventEmitter {
  webContents = new FakeContents();
  constructor() {
    super();
    contents = this.webContents;
  }
  static fromWebContents(): null {
    return null;
  }
  setTitle(): void {}
  isDestroyed(): boolean {
    return false;
  }
  isMinimized(): boolean {
    return false;
  }
  isFullScreen(): boolean {
    return false;
  }
  isVisible(): boolean {
    return true;
  }
  isAlwaysOnTop(): boolean {
    return false;
  }
  getNormalBounds(): Electron.Rectangle {
    return { x: 0, y: 0, width: 1280, height: 820 };
  }
  setTitleBarOverlay(): void {}
  setWindowButtonPosition(): void {}
  setBackgroundColor(): void {}
  setAlwaysOnTop(): void {}
  show(): void {}
  hide(): void {}
  focus(): void {}
  restore(): void {}
}

const workArea = { x: 0, y: 0, width: 2560, height: 1440 };

// mock.module is process-wide in Bun: list every export the other desktop
// tests import from electron, or a later file sees a module without them.
mock.module("electron", () => ({
  app: { getVersion: () => "1.0.0", getPath: () => userData, isPackaged: true },
  BrowserWindow: FakeBrowserWindow,
  clipboard: {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  nativeTheme: { themeSource: "system", shouldUseDarkColors: false, on: () => {}, off: () => {} },
  net: {},
  safeStorage: { isEncryptionAvailable: () => false },
  screen: { getPrimaryDisplay: () => ({ workArea }), getDisplayMatching: () => ({ workArea }) },
  shell: { openExternal: async () => {} },
}));

const { createShellWindow } = await import("../src/main/window");

const SIGNIN_PATH = "/app/src/renderer/signin.html";
const LOGIN = "https://console.example.com/login";
let consoleWithoutBridge = 0;

function createWindow(): ReturnType<typeof createShellWindow> {
  return createShellWindow({
    config: { consoleUrl: "https://console.example.com", apiOrigin: "https://api.example.com", clientId: "desktop", signinTemplate: "console-split" },
    preloadPath: "/app/dist/preload/preload.js",
    signinPath: SIGNIN_PATH,
    iconPath: "/app/src/renderer/icon.png",
    onAlwaysOnTopChange: () => {},
    onConsoleWithoutBridge: () => { consoleWithoutBridge++; },
  });
}

// Lets the window's promise chains (storage purge, then load) run.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  steps = [];
  consoleWithoutBridge = 0;
});

afterAll(() => rmSync(userData, { recursive: true, force: true }));

test("signed out, the window shows the console's /login, after the launch's service-worker purge", async () => {
  const window = createWindow();
  window.showSignin();
  await settle();
  expect(steps).toEqual(["clear serviceworkers,cachestorage", `load ${LOGIN}`]);
});

test("sign-out unloads the console, clears its IndexedDB, then loads /login, and the state reaches /login only", async () => {
  const window = createWindow();
  window.loadConsole();
  await settle();
  steps = [];

  const done = window.showSigninAndClearStorage();
  window.sendSigninState({ status: "idle", reason: "signed-out" });
  await done;
  contents.emit("dom-ready");

  expect(steps).toEqual([
    "localStorage cleanup",
    "load about:blank",
    "clear indexdb https://console.example.com",
    `load ${LOGIN}`,
    // Not pushed to the signed-in console mid-sign-out: replayed once /login is up.
    "send auth:state idle",
  ]);
});

test("states go to the console's /login as they change", async () => {
  const window = createWindow();
  window.showSignin();
  await settle();
  steps = [];
  window.sendSigninState({ status: "sending" });
  window.sendSigninState({ status: "code_sent", email: "member@example.com" });
  expect(steps).toEqual(["send auth:state sending", "send auth:state code_sent"]);
});

test("compatibility: an old console's signOut() from /login switches to the local page for the rest of the session", async () => {
  const window = createWindow();
  window.showSignin();
  await settle();
  steps = [];

  // The old console calls bridge.signOut() from /login while signed out.
  contents.url = `${LOGIN}?redirect=%2F`;
  expect(window.fallBackToLocalSignin()).toBe(true);
  await settle();
  expect(steps).toEqual(["file signin.html"]);

  // A second call from the page being replaced is not the /login case anymore.
  expect(window.fallBackToLocalSignin()).toBe(false);

  // Remembered: the next sign-out (after a sign-in) goes to the local page too,
  // still unloading the console before the IndexedDB goes.
  window.loadConsole();
  await settle();
  steps = [];
  await window.showSigninAndClearStorage();
  expect(steps).toEqual(["localStorage cleanup", "load about:blank", "clear indexdb https://console.example.com", "file signin.html"]);

  steps = [];
  window.showSignin();
  await settle();
  expect(steps).toEqual(["file signin.html"]);
});

test("no fallback when the window is not on the console's /login", async () => {
  const window = createWindow();
  window.loadConsole();
  await settle();
  expect(window.fallBackToLocalSignin()).toBe(false);

  window.showSignin();
  await settle();
  contents.url = "https://console.example.com/legal/terms";
  expect(window.fallBackToLocalSignin()).toBe(false);
  contents.url = "https://other.example.com/login";
  expect(window.fallBackToLocalSignin()).toBe(false);
});

test("the bridge probe is armed on the signed-in console, never on /login", async () => {
  jest.useFakeTimers();
  try {
    const window = createWindow();
    window.showSignin();
    await Promise.resolve();
    await Promise.resolve();
    contents.url = LOGIN;
    contents.emit("did-finish-load");
    jest.advanceTimersByTime(60_000);
    expect(consoleWithoutBridge).toBe(0);

    window.loadConsole();
    contents.url = "https://console.example.com/";
    contents.emit("did-finish-load");
    jest.advanceTimersByTime(60_000);
    expect(consoleWithoutBridge).toBe(1);
  } finally {
    jest.useRealTimers();
  }
});
