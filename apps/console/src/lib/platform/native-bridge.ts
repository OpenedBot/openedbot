import type { AuthStore } from "@openedbot/browser-api-client";
import { createTauriBridge } from "./tauri-bridge";
import type { NativeUpdatesBridge } from "./native-updates";
import type { NativeNotchBridge } from "./native-notch";

/**
 * The desktop app's bridge (`apps/desktop-tauri`), built on its
 * Rust commands by `tauri-bridge.ts` and set on `window.__OPENEDBOT_NATIVE__`.
 *
 * It exists only in the console's desktop build (`VITE_OPENEDBOT_SHELL=tauri`).
 * The web build is always a browser, whatever its page finds on
 * `window`: it keeps its HttpOnly session cookie and its CSRF token. In
 * the app, the bridge carries the identity (native access token of 15 min,
 * refreshed on the shell side with a rotating refresh token the page never
 * sees): each request leaves as `Authorization: Bearer`, with neither cookie nor
 * CSRF (the API's `auth.ts` requires CSRF only on a cookie session).
 */
export type OpenedbotNativeBridge = {
  /** The current token, refreshed by the shell if it expires; `null` signed out. */
  readAccessToken(): Promise<string | null>;
  /** Forces a rotation; `null` if the refresh is refused (the shell reopens its sign-in page). */
  refresh(): Promise<string | null>;
  /** Opens in the system browser; the shell accepts only https URLs of the console or the API. */
  openExternal(url: string): Promise<void>;
  /** Clears the tokens on the shell side and shows its sign-in page. */
  signOut(): Promise<void>;
  /** The system and the app version (the shell's `shell_info`). */
  shell: { platform: "windows" | "macos" | "linux"; version: string };
  /**
   * Sign-in led by the shell from the console's `/login` screen
   * (the same screen as the browser). Absent, the console hands back to the
   * shell (`signOut`).
   */
  auth?: NativeAuthBridge;
  /** The app update (Tauri shell only, `native-updates.ts`). */
  updates?: NativeUpdatesBridge;
  /** The notch (Tauri shell only, `native-notch.ts`; it exists only on Mac). */
  notch?: NativeNotchBridge;
};

/** The sign-in state pushed by the shell (the bridge's `SigninState`, `@openedbot/contracts-native-bridge`). */
export type NativeSigninState =
  | { status: "idle"; reason?: "signed-out" | "session-lost" }
  | { status: "waiting" | "submitting" | "code_required" | "sending" | "verifying" }
  | { status: "code_sent"; email: string }
  | { status: "error"; code: string; message: string; params?: Record<string, string> };

/**
 * The PKCE, the verifier and the tokens stay in the shell's main
 * process: the page only asks, and reads the outcome via `onState`.
 */
export type NativeAuthBridge = {
  requestEmailCode(email: string, locale: "fr" | "en"): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<void>;
  startGoogle(): Promise<void>;
  cancel(): Promise<void>;
  /** Receives the last known state at once, then each change; returns the unsubscribe. */
  onState(listener: (state: NativeSigninState) => void): () => void;
};

declare global {
  // Intended declaration merge: `Window` is the DOM's global type.
  interface Window {
    __OPENEDBOT_NATIVE__?: OpenedbotNativeBridge;
  }
}

/**
 * The mark set in `cloud-session` in place of the CSRF token when
 * the identity comes from the bridge: `readCloudSession()` requires a string, and
 * `request()` compares that identity before and after each response.
 */
export const NATIVE_SESSION_MARK = "native";

/**
 * The Tauri app has no preload: its bridge is built here, when the
 * module loads, on the Rust commands (`tauri-bridge.ts`). Only in the desktop
 * build (`VITE_OPENEDBOT_SHELL=tauri`, `apps/desktop-tauri`): elsewhere the
 * condition is false as of the build, and the Tauri module is not bundled.
 * The variable is written in full at each use: Vite replaces it with a
 * constant, and the minifier then drops the branch.
 */
if (import.meta.env.VITE_OPENEDBOT_SHELL === "tauri" && globalThis.window && !globalThis.window.__OPENEDBOT_NATIVE__) {
  const bridge = createTauriBridge();
  if (bridge) Object.defineProperty(globalThis.window, "__OPENEDBOT_NATIVE__", { value: bridge, writable: false, configurable: false });
}

/**
 * The app's bridge, `null` in a browser. The web build always answers
 * `null`: a page that hosts it and sets its own `__OPENEDBOT_NATIVE__`
 * (another shell, an extension) stays served as a browser, with
 * the session cookie, never entrusting the identity to that bridge.
 */
export function nativeBridge(): OpenedbotNativeBridge | null {
  if (import.meta.env.VITE_OPENEDBOT_SHELL !== "tauri") return null;
  const bridge = globalThis.window?.__OPENEDBOT_NATIVE__;
  return bridge && typeof bridge.readAccessToken === "function" ? bridge : null;
}

/** Sign-in by the shell, if this shell knows how to lead it; `null` in a browser or an old shell. */
export function nativeAuth(): NativeAuthBridge | null {
  const auth = nativeBridge()?.auth;
  return auth && typeof auth.requestEmailCode === "function" && typeof auth.verifyEmailCode === "function"
    && typeof auth.startGoogle === "function" && typeof auth.cancel === "function" && typeof auth.onState === "function"
    ? auth
    : null;
}

export function isNativeShell(): boolean {
  return nativeBridge() !== null;
}

/** The `AuthStore` expected by the SSE client (`@openedbot/browser-api-client`); `null` outside the shell. */
export function nativeAuthStore(): AuthStore | null {
  const bridge = nativeBridge();
  if (!bridge) return null;
  return {
    readAccessToken: () => bridge.readAccessToken(),
    refresh: () => bridge.refresh(),
  };
}
