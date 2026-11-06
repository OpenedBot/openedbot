import type { AuthStore } from "@openedbot/browser-api-client";
import { createTauriBridge } from "./tauri-bridge";

/**
 * Le pont que la coque native (dépôt voisin `openedbot-desktop`, Electron) expose au
 * renderer par `contextBridge.exposeInMainWorld("__OPENEDBOT_NATIVE__", ...)`.
 *
 * Dans un navigateur il n'existe pas : la console garde son cookie de session
 * HttpOnly et son jeton CSRF. Dans la coque, c'est le pont qui porte l'identité
 * (access token natif de 15 min, rafraîchi côté coque avec un refresh token
 * rotatif que le renderer ne voit jamais) : chaque requête part en
 * `Authorization: Bearer`, sans cookie ni CSRF (`auth.ts` de l'API n'exige le
 * CSRF que sur une session cookie). Le contrat est tenu par `apps/desktop`
 * (`src/shared/bridge.ts`) : ces quatre fonctions, plus `auth`, optionnel.
 */
export type OpenedbotNativeBridge = {
  /** Le jeton courant, rafraîchi par la coque s'il expire ; `null` déconnecté. */
  readAccessToken(): Promise<string | null>;
  /** Force une rotation ; `null` si le refresh est refusé (la coque rouvre sa page de connexion). */
  refresh(): Promise<string | null>;
  /** Ouvre dans le navigateur système ; la coque n'accepte que les URL https de la console ou de l'API. */
  openExternal(url: string): Promise<void>;
  /** Efface les jetons côté coque et montre sa page de connexion. */
  signOut(): Promise<void>;
  /**
   * `platform` : le système de la coque Tauri ; la coque Electron, dont le
   * contrat est figé, dit toujours "windows" (`native-titlebar.ts` lit alors
   * le système dans l'agent utilisateur).
   */
  shell: { platform: "windows" | "macos" | "linux"; version: string };
  /**
   * La connexion menée par la coque depuis l'écran `/login` de la console
   * (même écran que le navigateur). Absent d'une coque plus ancienne : la
   * console lui rend alors la main (`signOut`) et la coque montre sa page locale.
   */
  auth?: NativeAuthBridge;
};

/** L'état de connexion poussé par la coque (`SigninState` de `apps/desktop/src/shared/bridge.ts`). */
export type NativeSigninState =
  | { status: "idle"; reason?: "signed-out" | "session-lost" }
  | { status: "waiting" | "submitting" | "code_required" | "sending" | "verifying" }
  | { status: "code_sent"; email: string }
  | { status: "error"; code: string; message: string; params?: Record<string, string> };

/**
 * Le PKCE, le vérificateur et les jetons restent dans le processus principal
 * de la coque : la page ne fait que demander, et lire l'issue par `onState`.
 */
export type NativeAuthBridge = {
  requestEmailCode(email: string, locale: "fr" | "en"): Promise<void>;
  verifyEmailCode(email: string, code: string): Promise<void>;
  startGoogle(): Promise<void>;
  cancel(): Promise<void>;
  /** Reçoit aussitôt le dernier état connu, puis chaque changement ; renvoie le désabonnement. */
  onState(listener: (state: NativeSigninState) => void): () => void;
};

declare global {
  // Fusion de déclaration voulue : `Window` est le type global du DOM.
  interface Window {
    __OPENEDBOT_NATIVE__?: OpenedbotNativeBridge;
  }
}

/**
 * La marque posée dans `cloud-session` à la place du jeton CSRF quand
 * l'identité vient du pont : `readCloudSession()` exige une chaîne, et
 * `request()` compare cette identité avant et après chaque réponse.
 */
export const NATIVE_SESSION_MARK = "native";

/**
 * L'app Tauri n'a pas de preload : son pont se construit ici, au chargement du
 * module, sur les commandes Rust (`tauri-bridge.ts`). Seulement dans le build
 * desktop (`VITE_OPENEDBOT_SHELL=tauri`, `apps/desktop-tauri`) : ailleurs la
 * condition est fausse dès le build, et le module Tauri n'est pas embarqué.
 */
if (import.meta.env.VITE_OPENEDBOT_SHELL === "tauri" && globalThis.window && !globalThis.window.__OPENEDBOT_NATIVE__) {
  const bridge = createTauriBridge();
  if (bridge) Object.defineProperty(globalThis.window, "__OPENEDBOT_NATIVE__", { value: bridge, writable: false, configurable: false });
}

export function nativeBridge(): OpenedbotNativeBridge | null {
  const bridge = globalThis.window?.__OPENEDBOT_NATIVE__;
  return bridge && typeof bridge.readAccessToken === "function" ? bridge : null;
}

/** La connexion par la coque, si cette coque la sait mener ; `null` dans un navigateur ou une coque ancienne. */
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

/** L'`AuthStore` attendu par le client SSE (`@openedbot/browser-api-client`) ; `null` hors coque. */
export function nativeAuthStore(): AuthStore | null {
  const bridge = nativeBridge();
  if (!bridge) return null;
  return {
    readAccessToken: () => bridge.readAccessToken(),
    refresh: () => bridge.refresh(),
  };
}
