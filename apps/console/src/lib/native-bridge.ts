import type { AuthStore } from "@openedbot/browser-api-client";

/**
 * Le pont que la coque native (dépôt voisin `openedbot-desktop`, Electron) expose au
 * renderer par `contextBridge.exposeInMainWorld("__OHB_NATIVE__", ...)`.
 *
 * Dans un navigateur il n'existe pas : la console garde son cookie de session
 * HttpOnly et son jeton CSRF. Dans la coque, c'est le pont qui porte l'identité
 * (access token natif de 15 min, rafraîchi côté coque avec un refresh token
 * rotatif que le renderer ne voit jamais) : chaque requête part en
 * `Authorization: Bearer`, sans cookie ni CSRF (`auth.ts` de l'API n'exige le
 * CSRF que sur une session cookie). Le contrat est figé par `openedbot-desktop` :
 * ces quatre fonctions, rien de plus.
 */
export type OhbNativeBridge = {
  /** Le jeton courant, rafraîchi par la coque s'il expire ; `null` déconnecté. */
  readAccessToken(): Promise<string | null>;
  /** Force une rotation ; `null` si le refresh est refusé (la coque rouvre sa page de connexion). */
  refresh(): Promise<string | null>;
  /** Ouvre dans le navigateur système ; la coque n'accepte que les URL https de la console ou de l'API. */
  openExternal(url: string): Promise<void>;
  /** Efface les jetons côté coque et montre sa page de connexion. */
  signOut(): Promise<void>;
  shell: { platform: "windows"; version: string };
};

declare global {
  // Fusion de déclaration voulue : `Window` est le type global du DOM.
  interface Window {
    __OHB_NATIVE__?: OhbNativeBridge;
  }
}

/**
 * La marque posée dans `cloud-session` à la place du jeton CSRF quand
 * l'identité vient du pont : `readCloudSession()` exige une chaîne, et
 * `request()` compare cette identité avant et après chaque réponse.
 */
export const NATIVE_SESSION_MARK = "native";

export function nativeBridge(): OhbNativeBridge | null {
  const bridge = globalThis.window?.__OHB_NATIVE__;
  return bridge && typeof bridge.readAccessToken === "function" ? bridge : null;
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

/**
 * Ouvre une page de la console hors de la fenêtre compacte : navigateur
 * système dans la coque, nouvel onglet sinon. La fenêtre compacte ne montre
 * que le fil (DEV-139) : réglages, flotte et accueil s'ouvrent ailleurs.
 */
export function openInBrowser(path: string): void {
  const url = new URL(path, window.location.origin).toString();
  const bridge = nativeBridge();
  if (bridge) void bridge.openExternal(url);
  else window.open(url, "_blank", "noopener");
}
