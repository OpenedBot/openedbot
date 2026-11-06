import { nativeBridge, type OpenedbotNativeBridge } from "./native-bridge";

/**
 * La barre de titre de l'app de bureau.
 *
 * L'app ouvre sa fenêtre sans barre de titre : la console monte jusqu'au bord
 * haut et sa barre du haut (`board-chrome.tsx`, 46 px) devient celle de la
 * fenêtre, comme Codex, ChatGPT ou T3 Code. C'est donc la console qui sert de
 * poignée pour déplacer la fenêtre et qui laisse la place aux boutons du
 * système (`styles/components/native-titlebar.css`) :
 *
 * - macOS (`"mac"`) : les feux tricolores flottent dans le coin haut gauche ;
 * - Windows (`"windows"`) : la place de réduire, agrandir et fermer dans le
 *   coin haut droit (`env(titlebar-area-*)`, 46 px de haut), pour la coque
 *   Windows à venir (D4).
 *
 * Détection : le pont présent ET le système qu'il annonce (`shell.platform`).
 * Sous Linux, la fenêtre garde la barre du système. Dans un navigateur ou une
 * PWA, rien ne change.
 */
export type NativeTitlebar = "mac" | "windows";

export const NATIVE_TITLEBAR_ATTRIBUTE = "data-native-titlebar";
export const NATIVE_TITLEBAR_BAND_ATTRIBUTE = "data-native-titlebar-band";

export function nativeTitlebarFor(bridge: OpenedbotNativeBridge | null): NativeTitlebar | null {
  switch (bridge?.shell?.platform) {
    case "macos":
      return "mac";
    case "windows":
      return "windows";
    default:
      return null;
  }
}

/**
 * À appeler avant le premier rendu : `<html>` porte l'attribut dès le premier
 * paint, sans saut de mise en page. Pose aussi la bande de déplacement du
 * haut de fenêtre, une fois, en premier enfant de `<body>` : Chromium applique
 * les régions de déplacement dans l'ordre du document, donc tout ce qui vient
 * après peut s'y découper.
 */
export function applyNativeTitlebar(doc: Document = document): NativeTitlebar | null {
  const titlebar = nativeTitlebarFor(nativeBridge());
  if (!titlebar) return null;
  doc.documentElement.setAttribute(NATIVE_TITLEBAR_ATTRIBUTE, titlebar);
  if (!doc.querySelector(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`)) {
    const band = doc.createElement("div");
    band.setAttribute(NATIVE_TITLEBAR_BAND_ATTRIBUTE, "");
    band.setAttribute("aria-hidden", "true");
    doc.body.prepend(band);
  }
  return titlebar;
}
