// Backend target: which openedbot deployment the shell talks to. Pure (no electron
// import) so `bun test` can exercise it; config.ts and main.ts consume it.
//
// A target names the API backend (the native sign-in and every API call). It
// also carries a default console, which each source can still override on its
// own (OPENEDBOT_CONSOLE_URL): a non-production API usually serves the API only, so
// its console is the Vite server the developer runs locally.

/**
 * The production console: the built-in default. Its own host since the
 * landing left the console (2026-10-29); the apex now serves the public site.
 */
export const PRODUCTION_CONSOLE_URL = "https://console.openedbot.app";
/**
 * The production console before 2026-10-29, still trusted as a console origin
 * alongside the default (trustedConsoleOrigins): a config.json, defaults.json or
 * OPENEDBOT_CONSOLE_URL may still name it, and the apex keeps serving the console to
 * the desktop shell, then 308s its app paths to `console.`, during the apex
 * transition. Remove it with the site's desktop and app-path redirects.
 */
export const LEGACY_PRODUCTION_CONSOLE_URL = "https://openedbot.app";
/**
 * The production API for native clients, the built-in default: /api/* only
 * (../.. `OPENEDBOT_API_HOSTS`, since 2026-10-17). The console itself keeps /api
 * on its own name, which also stays served for builds that predate this host.
 */
export const PRODUCTION_API_ORIGIN = "https://api.openedbot.app";
/** The console a developer runs on the same PC (`apps/console`, Vite, port 1420). */
export const LOCAL_CONSOLE_URL = "http://localhost:1420";

export type TargetUrls = { consoleUrl: string; apiOrigin: string };

/**
 * The origins the shell treats as its console (navigation, IPC senders,
 * permissions, external links, sign-in hosts). Any configured console is
 * trusted alone, except the production console: its current and its former
 * (apex) origins go together, whichever one is configured, so the apex's
 * redirect to `console.` and an install still pinned to the apex keep working.
 */
export function trustedConsoleOrigins(consoleUrl: string): string[] {
  const origin = new URL(consoleUrl).origin;
  const production = new URL(PRODUCTION_CONSOLE_URL).origin;
  const legacy = new URL(LEGACY_PRODUCTION_CONSOLE_URL).origin;
  if (origin === production || origin === legacy) return [origin, origin === production ? legacy : production];
  return [origin];
}

/**
 * Reads a target setting: `prod`, or the URL of an API (a staging or custom
 * deployment, e.g. a LAN host). Returns null when the setting is absent; the
 * http/https policy is enforced afterwards by config.ts (`normalizeUrl`).
 */
export function resolveTarget(raw: unknown, source: string): TargetUrls | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new Error(`${source} must be prod or a URL`);
  const value = raw.trim();
  if (!value) return null;
  if (value === "prod") return { consoleUrl: PRODUCTION_CONSOLE_URL, apiOrigin: PRODUCTION_API_ORIGIN };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${source} must be prod or a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${source} must be prod or a http(s) URL`);
  return { consoleUrl: LOCAL_CONSOLE_URL, apiOrigin: url.origin };
}

/**
 * The tier an API origin stands for when the API does not say it itself (one
 * that predates the `environment` field of /api/health, or that does not
 * answer): production, and dev for anything else (the dev PC, a LAN host, a
 * custom URL). A staging API says `preprod` itself (/api/health).
 */
export function environmentOf(apiOrigin: string): "dev" | "preprod" | "prod" {
  if (apiOrigin === PRODUCTION_API_ORIGIN) return "prod";
  return "dev";
}

/** A short name for a non-production API, shown in the window title and the tray; null on production. */
export function targetLabel(apiOrigin: string): string | null {
  if (apiOrigin === PRODUCTION_API_ORIGIN) return null;
  return new URL(apiOrigin).host;
}

/**
 * The tokens file for one API. Production keeps the historical `tokens.bin`;
 * any other API gets its own file, so switching target never sends a refresh
 * token to the wrong server and never wipes the other session on its 401.
 */
export function tokensFileName(apiOrigin: string): string {
  if (apiOrigin === PRODUCTION_API_ORIGIN) return "tokens.bin";
  return `tokens-${new URL(apiOrigin).host.toLowerCase().replace(/[^a-z0-9.-]/g, "_")}.bin`;
}

/**
 * Dev only: the userData folder name for this environment. Decided from the
 * environment alone, because getConfig() reads userData and runs later. Each
 * backend gets its own folder, so a dev session never meets another one.
 */
export function devUserDataName(env: Record<string, string | undefined>): string {
  let apiOrigin = env.OPENEDBOT_API_ORIGIN?.trim().replace(/\/+$/, "");
  if (!apiOrigin) {
    try {
      apiOrigin = resolveTarget(env.OPENEDBOT_TARGET, "OPENEDBOT_TARGET")?.apiOrigin;
    } catch {
      // getConfig() reports the invalid value with a dialog; here, any name will do.
    }
  }
  if (apiOrigin === PRODUCTION_API_ORIGIN) return "openedbot (dev prod)";
  return "openedbot (dev)";
}
