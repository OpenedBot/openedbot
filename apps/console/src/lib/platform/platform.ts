import { nativeBridge } from "./native-bridge";

/**
 * What the console asks of the platform that carries it: a browser, or
 * the desktop app. The rest of the console goes through here (and through the
 * re-exports of `index.ts`), never through `native-bridge` or through
 * `location.origin` directly: `tests/scripts/console-platform-contract.ts`
 * checks it.
 *
 * Why: a console embedded in the desktop app is served from a
 * local origin (`tauri://localhost`). A shared link, a webhook
 * URL or a page opened in the browser must still point at
 * the public web console, never at that local origin.
 */

declare global {
  interface Window {
    /** Set by the desktop app when the console is not served from its public origin. */
    __OPENEDBOT_PUBLIC_CONSOLE_URL__?: string;
  }
}

/** The header by which the desktop app announces itself to the API (`client-version.ts` on the API side). */
export const CLIENT_HEADER = "X-OpenedBot-Client";

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/**
 * A public web origin: http(s), and not the local host under which Tauri
 * serves the console on Windows (`http://tauri.localhost`), which would otherwise pass
 * for a web origin in the fallback to the page's origin.
 */
function isWebOrigin(origin: string): boolean {
  if (!origin.startsWith("https://") && !origin.startsWith("http://")) return false;
  const host = new URL(origin).hostname;
  return host !== "tauri.localhost" && !host.endsWith(".tauri.localhost");
}

/**
 * The public origin of the web console (`https://openedbot.app`), with no trailing
 * slash. In a browser, it is the page's origin. In the desktop
 * app: the value set by the app, otherwise `VITE_PUBLIC_CONSOLE_URL`. An app
 * with neither is badly built: the error says so instead of
 * fabricating a `tauri://` link.
 */
export function publicConsoleOrigin(): string {
  const pageOrigin = globalThis.window?.location.origin ?? "";
  if (!nativeBridge()) return pageOrigin;
  const configured = globalThis.window?.__OPENEDBOT_PUBLIC_CONSOLE_URL__ ?? import.meta.env.VITE_PUBLIC_CONSOLE_URL ?? "";
  const trimmed = String(configured).trim().replace(/\/+$/, "");
  if (trimmed) {
    const origin = new URL(trimmed).origin;
    if (!isWebOrigin(origin)) throw new Error(`The public console URL must be http(s), got ${JSON.stringify(trimmed)}.`);
    return origin;
  }
  throw new Error("The desktop app serves the console locally but sets no public console URL (__OPENEDBOT_PUBLIC_CONSOLE_URL__ or VITE_PUBLIC_CONSOLE_URL).");
}

/** A page of the public web console: shared link, page opened in the browser. */
export function publicConsoleUrl(path: string): string {
  return new URL(path, `${publicConsoleOrigin()}/`).toString();
}

/**
 * Reads an app path (`/o/acme/bot/…`, with its query and its anchor) without
 * depending on the page's origin: only the path part counts.
 */
export function appUrl(href: string): URL {
  return new URL(href, "https://console.invalid/");
}

/** `desktop/X.Y.Z` in the desktop app, `null` in a browser or if the version is unreadable. */
export function desktopClientId(): string | null {
  const version = nativeBridge()?.shell?.version?.trim();
  return version && SEMVER.test(version) ? `desktop/${version}` : null;
}

/** The headers that announce the desktop app to the API (version guard `426`); empty in a browser. */
export function clientHeaders(): Record<string, string> {
  const client = desktopClientId();
  return client ? { [CLIENT_HEADER]: client } : {};
}

/**
 * A desktop-app request: client header, and never a cookie.
 * The identity there is the bridge's bearer, and the API lets the app's
 * origins through without `Access-Control-Allow-Credentials`: an `include` request
 * would be rejected by the WebView. In a browser, the request is returned
 * as-is.
 */
export function nativeRequestInit(init: RequestInit | undefined): RequestInit | undefined {
  if (!nativeBridge()) return init;
  return { ...withClientHeaders(init), credentials: "omit" };
}

/** Adds `clientHeaders()` to a request, without overwriting what the caller set. */
export function withClientHeaders(init: RequestInit | undefined): RequestInit | undefined {
  const extra = clientHeaders();
  if (Object.keys(extra).length === 0) return init;
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(extra)) if (!headers.has(name)) headers.set(name, value);
  return { ...init, headers };
}

/**
 * Opens a console page outside the compact window: system
 * browser in the shell, a new tab otherwise. The compact window shows
 * only the thread (DEV-139): settings and home open elsewhere. In
 * the shell, the address is the public web console's, never the embedded
 * console's local origin.
 */
export function openInBrowser(path: string): void {
  const bridge = nativeBridge();
  if (bridge) void bridge.openExternal(publicConsoleUrl(path));
  else window.open(new URL(path, window.location.origin).toString(), "_blank", "noopener");
}
