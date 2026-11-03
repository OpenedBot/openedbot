import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  devUserDataName,
  environmentOf,
  LEGACY_PRODUCTION_CONSOLE_URL,
  LOCAL_CONSOLE_URL,
  PRODUCTION_API_ORIGIN,
  PRODUCTION_CONSOLE_URL,
  resolveTarget,
  targetLabel,
  tokensFileName,
  trustedConsoleOrigins,
} from "../src/main/target";

test("the production console is console.openedbot.app, the API api.openedbot.app", () => {
  expect(PRODUCTION_CONSOLE_URL).toBe("https://console.openedbot.app");
  expect(PRODUCTION_API_ORIGIN).toBe("https://api.openedbot.app");
  expect(LEGACY_PRODUCTION_CONSOLE_URL).toBe("https://openedbot.app");
});

test("trustedConsoleOrigins: production trusts console. and the apex, any other console alone", () => {
  expect(trustedConsoleOrigins(PRODUCTION_CONSOLE_URL)).toEqual(["https://console.openedbot.app", "https://openedbot.app"]);
  // An install still pinned to the apex follows its 308 to console. without losing the bridge.
  expect(trustedConsoleOrigins("https://openedbot.app/")).toEqual(["https://openedbot.app", "https://console.openedbot.app"]);
  expect(trustedConsoleOrigins(LOCAL_CONSOLE_URL)).toEqual(["http://localhost:1420"]);
  expect(trustedConsoleOrigins("https://console.example.com/sub")).toEqual(["https://console.example.com"]);
  // Look-alikes are not production.
  expect(trustedConsoleOrigins("https://openedbot.app.example.com")).toEqual(["https://openedbot.app.example.com"]);
  expect(trustedConsoleOrigins("http://openedbot.app")).toEqual(["http://openedbot.app"]);
});

test("resolveTarget: prod and an API URL", () => {
  expect(resolveTarget("prod", "T")).toEqual({ consoleUrl: PRODUCTION_CONSOLE_URL, apiOrigin: PRODUCTION_API_ORIGIN });
  // Any other API is reached by its URL, with the developer's local console.
  expect(resolveTarget("https://api.staging.example.test/", "T")).toEqual({ consoleUrl: LOCAL_CONSOLE_URL, apiOrigin: "https://api.staging.example.test" });
  expect(resolveTarget(" http://10.0.0.50:8790/ignored ", "T")).toEqual({ consoleUrl: LOCAL_CONSOLE_URL, apiOrigin: "http://10.0.0.50:8790" });
});

test("resolveTarget: absent is null, garbage throws naming the source", () => {
  expect(resolveTarget(undefined, "T")).toBeNull();
  expect(resolveTarget("  ", "T")).toBeNull();
  expect(() => resolveTarget("staging", "OPENEDBOT_TARGET")).toThrow("OPENEDBOT_TARGET must be");
  // No preset besides prod: a named environment is an error, not a hidden URL.
  expect(() => resolveTarget("preprod", "OPENEDBOT_TARGET")).toThrow("OPENEDBOT_TARGET must be prod or a URL");
  expect(() => resolveTarget("ftp://example.com", "OPENEDBOT_TARGET")).toThrow("OPENEDBOT_TARGET must be");
  expect(() => resolveTarget(42, "OPENEDBOT_TARGET")).toThrow("OPENEDBOT_TARGET must be");
});

test("targetLabel is null on production only", () => {
  expect(targetLabel(PRODUCTION_API_ORIGIN)).toBeNull();
  expect(targetLabel("https://api.staging.example.test")).toBe("api.staging.example.test");
  expect(targetLabel("http://10.0.0.50:8790")).toBe("10.0.0.50:8790");
});

test("environmentOf: production by its origin, dev for any other API", () => {
  expect(environmentOf(PRODUCTION_API_ORIGIN)).toBe("prod");
  expect(environmentOf("http://localhost:1420")).toBe("dev");
  expect(environmentOf("https://staging.example.test")).toBe("dev");
});

test("tokensFileName keeps tokens.bin for production and splits every other API", () => {
  expect(tokensFileName(PRODUCTION_API_ORIGIN)).toBe("tokens.bin");
  expect(tokensFileName("https://api.staging.example.test")).toBe("tokens-api.staging.example.test.bin");
  expect(tokensFileName("http://10.0.0.50:8790")).toBe("tokens-10.0.0.50_8790.bin");
});

test("devUserDataName follows the backend the environment aims at", () => {
  expect(devUserDataName({})).toBe("openedbot (dev)");
  expect(devUserDataName({ OPENEDBOT_API_ORIGIN: `${PRODUCTION_API_ORIGIN}/` })).toBe("openedbot (dev prod)");
  expect(devUserDataName({ OPENEDBOT_TARGET: "prod" })).toBe("openedbot (dev prod)");
  expect(devUserDataName({ OPENEDBOT_TARGET: "preprod" })).toBe("openedbot (dev)");
  expect(devUserDataName({ OPENEDBOT_TARGET: "nonsense" })).toBe("openedbot (dev)");
});

// getConfig() end to end, with electron mocked: precedence between sources.
const userData = mkdtempSync(path.join(tmpdir(), "ohb-config-"));
// Every named export a transitively imported main module reads must exist on
// the mock: bun keeps one electron mock across files, and a missing name (net)
// fails the link of the next file that imports it.
mock.module("electron", () => ({ app: { isPackaged: false, getPath: () => userData }, net: {}, shell: {}, ipcMain: { handle() {}, on() {} }, nativeTheme: {}, safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: class {}, clipboard: {}, Menu: {}, screen: {} }));
const ENV_NAMES = ["OPENEDBOT_TARGET", "OPENEDBOT_CONSOLE_URL", "OPENEDBOT_API_ORIGIN", "OPENEDBOT_SIGNIN_TEMPLATE", "NODE_ENV_ELECTRON_VITE"];
let imports = 0;

async function configWith(env: Record<string, string>) {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, env);
  // A fresh module instance each time: getConfig() caches its first answer.
  const { getConfig } = await import(`../src/main/config?case=${imports++}`);
  return getConfig();
}

afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});

test("getConfig: no setting is production", async () => {
  expect(await configWith({})).toMatchObject({ consoleUrl: PRODUCTION_CONSOLE_URL, apiOrigin: PRODUCTION_API_ORIGIN });
});

test("getConfig: OPENEDBOT_TARGET=<API URL> aims that API and the local console", async () => {
  expect(await configWith({ OPENEDBOT_TARGET: "https://api.staging.example.test" })).toMatchObject({ consoleUrl: LOCAL_CONSOLE_URL, apiOrigin: "https://api.staging.example.test" });
});

test("getConfig: the console is set apart from the API", async () => {
  const config = await configWith({ OPENEDBOT_TARGET: "https://api.staging.example.test", OPENEDBOT_CONSOLE_URL: "http://localhost:5555" });
  expect(config).toMatchObject({ consoleUrl: "http://localhost:5555", apiOrigin: "https://api.staging.example.test" });
});

test("getConfig: an explicit API origin beats the target", async () => {
  const config = await configWith({ OPENEDBOT_TARGET: "https://api.staging.example.test", OPENEDBOT_API_ORIGIN: "http://10.0.0.50:8790" });
  expect(config.apiOrigin).toBe("http://10.0.0.50:8790");
});

test("getConfig: plain http is refused off a lab host, even through a target", async () => {
  await expect(configWith({ OPENEDBOT_TARGET: "http://example.com" })).rejects.toThrow("must be https");
});

test("getConfig: OPENEDBOT_CONSOLE_URL still overrides the built-in console, the API stays production", async () => {
  const config = await configWith({ OPENEDBOT_CONSOLE_URL: "https://openedbot.app/" });
  expect(config).toMatchObject({ consoleUrl: "https://openedbot.app", apiOrigin: PRODUCTION_API_ORIGIN });
  expect((await configWith({ OPENEDBOT_CONSOLE_URL: "http://localhost:5555" })).consoleUrl).toBe("http://localhost:5555");
});

test("parseTrustedExternalUrl: production opens console., the apex and the API, nothing else", async () => {
  const { getConfig, parseTrustedExternalUrl } = await import(`../src/main/config?case=${imports++}`);
  for (const name of ENV_NAMES) delete process.env[name];
  const config = getConfig();
  for (const url of ["https://console.openedbot.app/legal/privacy", "https://openedbot.app/legal/terms", "https://api.openedbot.app/api/health"]) {
    expect(parseTrustedExternalUrl(url, config).toString()).toBe(url);
  }
  expect(() => parseTrustedExternalUrl("https://evil.example.com/", config)).toThrow("URL origin not allowed");
  const local = { ...config, consoleUrl: "https://console.example.com" };
  expect(() => parseTrustedExternalUrl("https://openedbot.app/", local)).toThrow("URL origin not allowed");
});
