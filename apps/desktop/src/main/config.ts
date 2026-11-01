import { app } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isElectronViteDev } from "./dev-reload";
import { log } from "./log";
import { PRODUCTION_API_ORIGIN, PRODUCTION_CONSOLE_URL, resolveTarget, trustedConsoleOrigins } from "./target";

export type DesktopConfig = {
  /** Console web origin + path prefix, no trailing slash. The shell loads `${consoleUrl}/compact`. */
  consoleUrl: string;
  /** API origin (no path). */
  apiOrigin: string;
  /** OAuth client id sent to /api/auth/native/google/start. */
  clientId: string;
  /** Sign-in page template, a file of src/renderer/templates/ (see window.ts). */
  signinTemplate: string;
};

// Re-exported: main.ts and the tests import them from here.
export { PRODUCTION_API_ORIGIN, PRODUCTION_CONSOLE_URL };

const DEFAULTS: DesktopConfig = {
  consoleUrl: PRODUCTION_CONSOLE_URL,
  apiOrigin: PRODUCTION_API_ORIGIN,
  clientId: "ohb-desktop-windows",
  signinTemplate: "console-split",
};

// A dev run (`electron-vite dev`, never packaged) started without the
// variables (a bare `bun dev`, an IDE task) used to fall back to production
// and sign the developer into the real service (seen 2026-10-12). Its
// built-in default is the dev PC's console instead: its Vite server listens on
// the LAN, so this address works from the dev PC itself and from the Windows
// replica (CLAUDE.md, "Working from Windows"). The console proxies /api.
export const DEV_CONSOLE_URL = "http://localhost:1420";

// Precedence: environment variable > userData/config.json > packaged
// defaults.json > built-in default (DEV_CONSOLE_URL for a dev run). Inside each
// source an explicit field (consoleUrl, apiOrigin) beats that source's
// `target` (OHB_TARGET: prod, preprod or an API URL, see target.ts), which
// fills in both. So a target never overrides a more specific setting of a
// higher source, and without any target the built-in default stays production.
// The user file exists so a tester can aim
// the shell at the lab without a shell environment (a Start menu launch has
// none); the packaged file is written by `make package-win CONSOLE_URL=...`
// so a test build targets the right console out of the box.
type ConfigSource = Partial<Record<keyof DesktopConfig | "target", unknown>>;

const ENV_KEYS: Record<keyof DesktopConfig | "target", string> = {
  consoleUrl: "OHB_CONSOLE_URL",
  apiOrigin: "OHB_API_ORIGIN",
  clientId: "OHB_CLIENT_ID",
  signinTemplate: "OHB_SIGNIN_TEMPLATE",
  target: "OHB_TARGET",
};

function readEnvConfig(): ConfigSource {
  const source: ConfigSource = {};
  for (const [key, name] of Object.entries(ENV_KEYS)) source[key as keyof ConfigSource] = process.env[name]?.trim();
  return source;
}

function readJsonConfig(file: string, label: string): ConfigSource {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    // A missing file is the normal case; a malformed one is worth a warning.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`${label} ignored (unreadable or invalid JSON)`);
    return {};
  }
}

function readFileConfig(): ConfigSource {
  return readJsonConfig(path.join(app.getPath("userData"), "config.json"), "config.json");
}

// Written next to main.js at packaging time (inside the asar); absent in dev.
function readPackagedDefaults(): ConfigSource {
  return readJsonConfig(path.join(__dirname, "defaults.json"), "defaults.json");
}

// The lab runs over plain http on a LAN or loopback host. Anything else must
// be https: the bearer token travels on these URLs.
function isLabHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname.endsWith(".localhost")) return true;
  if (/\.(local|lan|test)$/.test(hostname)) return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function normalizeUrl(name: string, value: string, keepPath: boolean): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLabHost(url.hostname))) {
    throw new Error(`${name} must be https (http is only accepted for loopback or LAN hosts)`);
  }
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  return keepPath ? `${url.origin}${trimmedPath}` : url.origin;
}

let cached: DesktopConfig | null = null;

export function getConfig(): DesktopConfig {
  if (cached) return cached;
  const sources: Array<[string, ConfigSource]> = [
    [ENV_KEYS.target, readEnvConfig()],
    ["config.json target", readFileConfig()],
    ["defaults.json target", readPackagedDefaults()],
  ];
  const pick = (key: keyof DesktopConfig): string => {
    for (const [targetName, source] of sources) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (key === "consoleUrl" || key === "apiOrigin") {
        const target = resolveTarget(source.target, targetName);
        if (target) return target[key];
      }
    }
    if (isElectronViteDev && (key === "consoleUrl" || key === "apiOrigin")) return DEV_CONSOLE_URL;
    return DEFAULTS[key];
  };
  cached = {
    consoleUrl: normalizeUrl("OHB_CONSOLE_URL", pick("consoleUrl"), true),
    apiOrigin: normalizeUrl("OHB_API_ORIGIN", pick("apiOrigin"), false),
    clientId: pick("clientId"),
    // A template name becomes a file name: letters, digits and dashes only.
    signinTemplate: /^[a-z0-9-]{1,40}$/.test(pick("signinTemplate")) ? pick("signinTemplate") : DEFAULTS.signinTemplate,
  };
  return cached;
}

/** The shell talks to the production API (built-in default), not a lab or the dev PC. */
export function isProductionApi(config: DesktopConfig = getConfig()): boolean {
  return config.apiOrigin === DEFAULTS.apiOrigin;
}

/** Every origin trusted as the console, the configured one first (target.ts, trustedConsoleOrigins). */
export function consoleOrigins(config: DesktopConfig = getConfig()): string[] {
  return trustedConsoleOrigins(config.consoleUrl);
}

/**
 * Validates a URL handed over by the renderer for the system browser. Only the
 * console (consoleOrigins) and api origins qualify, over https (http only when that very origin
 * was configured as a lab host): the page could be compromised by injected
 * content, and `shell.openExternal` will launch whatever handler the OS maps to
 * the scheme.
 */
export function parseTrustedExternalUrl(raw: unknown, config: DesktopConfig = getConfig()): URL {
  if (typeof raw !== "string" || raw.length > 4096) throw new Error("Invalid URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  const trusted = [...consoleOrigins(config), config.apiOrigin];
  if (!trusted.includes(url.origin)) throw new Error("URL origin not allowed");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("URL scheme not allowed");
  // normalizeUrl already guarantees an http origin is a lab host.
  return url;
}
