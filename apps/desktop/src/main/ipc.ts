import { ipcMain, nativeTheme, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { TEXT_ZOOM_FACTORS, type IpcChannel, type PasswordCredentials } from "../shared/bridge";
import type { AuthService } from "./auth";
import { consoleOrigins, parseTrustedExternalUrl, type DesktopConfig } from "./config";
import { isLegalSlug, readSigninContext } from "./signin-context";

export type IpcDeps = {
  auth: AuthService;
  config: DesktopConfig;
  /** file: URL of the local sign-in page. */
  signinUrl: string;
  /** Any bridge call from the console proves it supports the shell. */
  onBridgeUse(): void;
  /** The console's text size (Apparence), as a page zoom factor already validated. */
  onTextZoom(factor: number): void;
  /** The zoom a console page starts with, read synchronously by the preload. */
  initialTextZoom(): number;
};

// Every handler re-checks who is calling. contextIsolation keeps the page from
// touching the preload, but a navigated or framed page (an iframe on the
// console origin, a stale tab) must still not reach the token.
function senderHref(event: IpcMainInvokeEvent | IpcMainEvent): string | null {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return null;
  return frame.url;
}

function handle<T>(channel: IpcChannel, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => handler(event, ...args));
}

export function registerIpc({ auth, config, signinUrl, onBridgeUse, onTextZoom, initialTextZoom }: IpcDeps): void {
  const trustedOrigins = consoleOrigins(config);
  const isTrusted = (origin: string | null): boolean => origin !== null && trustedOrigins.includes(origin);

  // Internal preload channel: theme updates must not count as an auth bridge probe.
  handle("ohb:theme", (event, mode) => {
    const href = senderHref(event);
    if (!href || (href.split(/[?#]/)[0] !== signinUrl && !isTrusted(new URL(href).origin))) {
      throw new Error("Forbidden sender");
    }
    if (mode !== "light" && mode !== "dark" && mode !== "system") throw new Error("Invalid theme");
    nativeTheme.themeSource = mode;
  });

  // Internal preload channel too: the console's text size zooms the whole
  // window. Only the console sets it; the sign-in page stays at 100 %.
  handle("ohb:text-zoom", (event, factor) => {
    const href = senderHref(event);
    let origin: string | null = null;
    try {
      origin = href ? new URL(href).origin : null;
    } catch {
      origin = null;
    }
    if (!isTrusted(origin)) throw new Error("Forbidden sender");
    if (typeof factor !== "number" || !TEXT_ZOOM_FACTORS.includes(factor)) throw new Error("Invalid text zoom");
    onTextZoom(factor);
  });

  // The one synchronous channel: the preload asks before the page paints, so
  // a reload or a launch starts at the console's size instead of 100 % then
  // jumping once its JavaScript runs. Answers 1 (no zoom) to anyone but the
  // console's main frame, never throws (a thrown sync handler hangs the page).
  ipcMain.on("ohb:text-zoom-initial" satisfies IpcChannel, (event: IpcMainEvent) => {
    const href = senderHref(event);
    let origin: string | null = null;
    try {
      origin = href ? new URL(href).origin : null;
    } catch {
      origin = null;
    }
    event.returnValue = isTrusted(origin) ? initialTextZoom() : 1;
  });

  const fromConsole = (event: IpcMainInvokeEvent): void => {
    const href = senderHref(event);
    let origin: string | null = null;
    try {
      origin = href ? new URL(href).origin : null;
    } catch {
      origin = null;
    }
    if (!isTrusted(origin)) throw new Error("Forbidden sender");
    onBridgeUse();
  };

  const fromSignin = (event: IpcMainInvokeEvent): void => {
    const href = senderHref(event);
    if (!href || href.split(/[?#]/)[0] !== signinUrl) throw new Error("Forbidden sender");
  };

  handle("ohb:read-access-token", (event) => {
    fromConsole(event);
    return auth.readAccessToken();
  });

  handle("ohb:refresh", (event) => {
    fromConsole(event);
    return auth.refresh();
  });

  handle("ohb:open-external", async (event, url) => {
    fromConsole(event);
    // Throws (so the renderer promise rejects) for anything outside the console/api origins.
    await shell.openExternal(parseTrustedExternalUrl(url, config).toString());
  });

  handle("ohb:sign-out", (event) => {
    fromConsole(event);
    auth.signOut();
  });

  handle("auth:start", (event) => {
    fromSignin(event);
    auth.startSignIn();
  });

  handle("auth:password", (event, raw) => {
    fromSignin(event);
    auth.signInWithPassword(parseCredentials(raw));
  });

  handle("auth:cancel", (event) => {
    fromSignin(event);
    auth.cancelSignIn();
  });

  handle("auth:context", (event) => {
    fromSignin(event);
    return readSigninContext(config);
  });

  // Only the three legal pages of the configured console, never a URL from the page.
  handle("auth:open-legal", async (event, slug) => {
    fromSignin(event);
    if (!isLegalSlug(slug)) throw new Error("Unknown legal document");
    await shell.openExternal(`${config.consoleUrl}/legal/${slug}`);
  });
}

// Same bounds as the API (email 320, password 1024): anything else is not a
// form submission and is refused before any request leaves.
function parseCredentials(raw: unknown): PasswordCredentials {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const password = typeof record.password === "string" ? record.password : "";
  if (!email || email.length > 320 || !password || password.length > 1024) throw new Error("Invalid credentials payload");
  if (record.emailCode === undefined || record.emailCode === "") return { email, password };
  if (typeof record.emailCode !== "string" || !/^\d{6}$/.test(record.emailCode)) {
    throw new Error("Invalid e-mail code payload");
  }
  return { email, password, emailCode: record.emailCode };
}
