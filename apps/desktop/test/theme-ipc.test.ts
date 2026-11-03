import { beforeEach, expect, mock, test } from "bun:test";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, (event: { returnValue?: unknown }) => void>();
const theme = { themeSource: "system" };
mock.module("electron", () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: (channel: string, listener: (event: { returnValue?: unknown }) => void) => listeners.set(channel, listener),
  },
  nativeTheme: theme,
  shell: {},
  // Imported by window.ts (window-signin.test.ts).
  BrowserWindow: class {},
  clipboard: {},
  Menu: {},
  screen: {},
  net: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));
const { registerIpc } = await import("../src/main/ipc");
let bridgeCalls = 0;

beforeEach(() => {
  theme.themeSource = "system";
  bridgeCalls = 0;
  registerIpc({
    auth: {} as never,
    config: { consoleUrl: "https://console.example.com", apiOrigin: "https://api.example.com", clientId: "desktop", signinTemplate: "console-split" },
    signinUrl: "file:///app/signin.html",
    onBridgeUse: () => { bridgeCalls++; },
    fallBackToLocalSignin: () => false,
    onTextZoom: () => {},
    initialTextZoom: () => 11 / 14,
  });
});

function update(url: string, mode: unknown, subframe = false): unknown {
  const frame = { url };
  return handlers.get("ohb:theme")!({ senderFrame: frame, sender: { mainFrame: subframe ? {} : frame } }, mode);
}

test("console theme changes follow explicit modes and restore system tracking", () => {
  for (const mode of ["dark", "light", "system"]) {
    update("https://console.example.com/settings/appearance", mode);
    expect(theme.themeSource).toBe(mode);
  }
  expect(bridgeCalls).toBe(0);
});

test("the local sign-in page also controls the native theme", () => {
  update("file:///app/signin.html?template=console-split", "dark");
  expect(theme.themeSource).toBe("dark");
});

test("foreign pages, other local files and subframes cannot change the theme", () => {
  for (const url of ["https://other.example.com", "file:///app/other.html"]) {
    expect(() => update(url, "dark")).toThrow("Forbidden sender");
  }
  expect(() => update("https://console.example.com", "dark", true)).toThrow("Forbidden sender");
  expect(theme.themeSource).toBe("system");
});

test("invalid theme payloads leave the native theme unchanged", () => {
  for (const mode of [null, {}, "automatic", "Dark"]) {
    expect(() => update("https://console.example.com", mode)).toThrow("Invalid theme");
  }
  expect(theme.themeSource).toBe("system");
});

function initialZoom(url: string, subframe = false): unknown {
  const frame = { url };
  const event: { returnValue?: unknown; senderFrame: unknown; sender: unknown } = { senderFrame: frame, sender: { mainFrame: subframe ? {} : frame } };
  listeners.get("ohb:text-zoom-initial")!(event);
  return event.returnValue;
}

test("only the console's main frame reads the kept text zoom; anyone else gets 100 %", () => {
  expect(initialZoom("https://console.example.com/settings/connectors")).toBe(11 / 14);
  expect(initialZoom("https://other.example.com")).toBe(1);
  expect(initialZoom("file:///app/signin.html")).toBe(1);
  expect(initialZoom("https://console.example.com", true)).toBe(1);
  expect(initialZoom("not a url")).toBe(1);
});

test("on production, the console and its former apex origin are both trusted senders", () => {
  registerIpc({
    auth: {} as never,
    config: { consoleUrl: "https://console.openedbot.app", apiOrigin: "https://api.openedbot.app", clientId: "desktop", signinTemplate: "console-split" },
    signinUrl: "file:///app/signin.html",
    onBridgeUse: () => {},
    fallBackToLocalSignin: () => false,
    onTextZoom: () => {},
    initialTextZoom: () => 11 / 14,
  });
  for (const url of ["https://console.openedbot.app/settings", "https://openedbot.app/settings"]) {
    update(url, "dark");
    expect(theme.themeSource).toBe("dark");
    theme.themeSource = "system";
    expect(initialZoom(url)).toBe(11 / 14);
  }
  expect(() => update("https://console.example.com", "dark")).toThrow("Forbidden sender");
  expect(() => update("https://openedbot.app.example.com", "dark")).toThrow("Forbidden sender");
});
