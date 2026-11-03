import { beforeEach, expect, mock, test } from "bun:test";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
mock.module("electron", () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: () => undefined,
  },
  nativeTheme: { themeSource: "system" },
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

const CONSOLE_LOGIN = "https://console.example.com/login";
const SIGNIN_PAGE = "file:///app/signin.html?template=console-split";

let calls: string[] = [];
let signedIn = false;
let fallBack = false;
let bridgeUses = 0;

beforeEach(() => {
  calls = [];
  signedIn = false;
  fallBack = false;
  bridgeUses = 0;
  registerIpc({
    auth: {
      isSignedIn: () => signedIn,
      startSignIn: () => calls.push("startSignIn"),
      cancelSignIn: () => calls.push("cancelSignIn"),
      requestEmailCode: (email: string, locale: string) => calls.push(`requestEmailCode ${email} ${locale}`),
      verifyEmailCode: (email: string, code: string) => calls.push(`verifyEmailCode ${email} ${code}`),
      signOut: () => calls.push("signOut"),
    } as never,
    config: { consoleUrl: "https://console.example.com", apiOrigin: "https://api.example.com", clientId: "desktop", signinTemplate: "console-split" },
    signinUrl: "file:///app/signin.html",
    onBridgeUse: () => { bridgeUses++; },
    fallBackToLocalSignin: () => {
      calls.push("fallBackToLocalSignin");
      return fallBack;
    },
    onTextZoom: () => {},
    initialTextZoom: () => 1,
  });
});

function invoke(channel: string, url: string, ...args: unknown[]): unknown {
  const frame = { url };
  return handlers.get(channel)!({ senderFrame: frame, sender: { mainFrame: frame } }, ...args);
}

function invokeFromSubframe(channel: string, url: string, ...args: unknown[]): unknown {
  return handlers.get(channel)!({ senderFrame: { url }, sender: { mainFrame: {} } }, ...args);
}

test("the console's /login and the local page both drive the e-mail code, Google and cancel", () => {
  for (const url of [CONSOLE_LOGIN, SIGNIN_PAGE]) {
    invoke("auth:email-code", url, "member@example.com", "fr");
    invoke("auth:email-verify", url, "member@example.com", "012345");
    invoke("auth:start", url);
    invoke("auth:cancel", url);
  }
  expect(calls).toEqual([
    "requestEmailCode member@example.com fr",
    "verifyEmailCode member@example.com 012345",
    "startSignIn",
    "cancelSignIn",
    "requestEmailCode member@example.com fr",
    "verifyEmailCode member@example.com 012345",
    "startSignIn",
    "cancelSignIn",
  ]);
  // The console's calls prove it supports the shell; the local page's do not count.
  expect(bridgeUses).toBe(4);
});

test("any other origin, another local file or a subframe is refused before anything runs", () => {
  for (const url of ["https://other.example.com/login", "https://console.example.com.evil.test/login", "file:///app/other.html", "about:blank", "not a url"]) {
    expect(() => invoke("auth:email-code", url, "member@example.com", "fr")).toThrow("Forbidden sender");
    expect(() => invoke("auth:email-verify", url, "member@example.com", "012345")).toThrow("Forbidden sender");
    expect(() => invoke("auth:start", url)).toThrow("Forbidden sender");
    expect(() => invoke("auth:cancel", url)).toThrow("Forbidden sender");
  }
  expect(() => invokeFromSubframe("auth:email-verify", CONSOLE_LOGIN, "member@example.com", "012345")).toThrow("Forbidden sender");
  expect(() => invokeFromSubframe("auth:start", SIGNIN_PAGE)).toThrow("Forbidden sender");
  expect(calls).toEqual([]);
});

test("the password, context and legal channels stay with the local page", () => {
  expect(() => invoke("auth:password", CONSOLE_LOGIN, { email: "member@example.com", password: "secret" })).toThrow("Forbidden sender");
  expect(() => invoke("auth:context", CONSOLE_LOGIN)).toThrow("Forbidden sender");
  expect(() => invoke("auth:open-legal", CONSOLE_LOGIN, "terms")).toThrow("Forbidden sender");
});

test("malformed e-mails, locales and codes are refused, and the error never quotes them", () => {
  const badEmails: unknown[] = ["", "a@", "no-at-sign", `${"a".repeat(316)}@b.co`, 42, null, { email: "member@example.com" }];
  for (const email of badEmails) {
    expect(() => invoke("auth:email-code", CONSOLE_LOGIN, email, "fr")).toThrow("Invalid e-mail payload");
    expect(() => invoke("auth:email-verify", CONSOLE_LOGIN, email, "012345")).toThrow("Invalid e-mail payload");
  }
  for (const locale of [undefined, "de", "FR", "fr-FR", 1]) {
    expect(() => invoke("auth:email-code", CONSOLE_LOGIN, "member@example.com", locale)).toThrow("Invalid locale payload");
  }
  for (const code of [undefined, "", "12345", "1234567", "12a456", " 123456", "123456\n", 123456, "１２３４５６"]) {
    expect(() => invoke("auth:email-verify", CONSOLE_LOGIN, "member@example.com", code)).toThrow("Invalid e-mail code payload");
  }
  try {
    invoke("auth:email-verify", CONSOLE_LOGIN, "member@example.com", "98765x");
  } catch (error) {
    expect(String(error)).not.toContain("98765x");
    expect(String(error)).not.toContain("member@example.com");
  }
  expect(calls).toEqual([]);
});

test("e-mail bounds: 3 and 320 characters pass, surrounding spaces are trimmed", () => {
  invoke("auth:email-code", CONSOLE_LOGIN, "a@b", "en");
  invoke("auth:email-code", CONSOLE_LOGIN, `${"a".repeat(314)}@b.com`, "en");
  invoke("auth:email-verify", CONSOLE_LOGIN, "  member@example.com ", "000000");
  expect(calls).toEqual([
    "requestEmailCode a@b en",
    `requestEmailCode ${"a".repeat(314)}@b.com en`,
    "verifyEmailCode member@example.com 000000",
  ]);
});

test("sign-out while signed in signs out, without asking the window", () => {
  signedIn = true;
  invoke("ohb:sign-out", "https://console.example.com/settings");
  expect(calls).toEqual(["signOut"]);
});

test("compatibility: sign-out while already signed out from an old /login falls back to the local page, no sign-out loop", () => {
  fallBack = true;
  invoke("ohb:sign-out", CONSOLE_LOGIN);
  expect(calls).toEqual(["fallBackToLocalSignin"]);
});

test("sign-out while signed out elsewhere than /login still signs out (the window declined the fallback)", () => {
  fallBack = false;
  invoke("ohb:sign-out", "https://console.example.com/settings");
  expect(calls).toEqual(["fallBackToLocalSignin", "signOut"]);
});
