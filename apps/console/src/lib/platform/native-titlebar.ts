import { nativeBridge, type OpenedbotNativeBridge } from "./native-bridge";

/**
 * La barre de titre de la coque native, sous macOS et sous Windows.
 *
 * `openedbot-desktop` ouvre sa fenêtre sans barre de titre (`titleBarStyle:
 * "hidden"`) : la console monte jusqu'au bord haut et sa barre du haut
 * (`board-chrome.tsx`, 46 px) devient celle de la fenêtre, comme Codex,
 * ChatGPT ou T3 Code. C'est donc la console qui sert de poignée pour déplacer
 * la fenêtre et qui laisse la place aux boutons du système
 * (`styles/components/native-titlebar.css`) :
 *
 * - macOS (`"mac"`) : les feux tricolores flottent dans le coin haut gauche ;
 * - Windows (`"windows"`) : la coque dessine réduire, agrandir et fermer
 *   par-dessus le coin haut droit (`titleBarOverlay`, 46 px de haut).
 *
 * Détection : le pont présent ET sa plateforme. La coque Tauri la dit
 * (`"macos"`) ; celle d'Electron dit toujours `"windows"` (contrat figé),
 * la plateforme se lit alors sur le navigateur. Dans un navigateur ou une
 * PWA, rien ne change.
 */
export type NativeTitlebar = "mac" | "windows";

export const NATIVE_TITLEBAR_ATTRIBUTE = "data-native-titlebar";
export const NATIVE_TITLEBAR_BAND_ATTRIBUTE = "data-native-titlebar-band";

export function nativeTitlebarFor(
  bridge: OpenedbotNativeBridge | null,
  nav: { platform: string; userAgent: string },
): NativeTitlebar | null {
  if (!bridge) return null;
  if (bridge.shell?.platform === "macos") return "mac";
  // `MacIntel` aussi sur Apple Silicon ; l'UA d'Electron porte « Macintosh ».
  if (nav.platform.startsWith("Mac") || /Macintosh/.test(nav.userAgent)) return "mac";
  // `Win32` aussi en 64 bits ; l'UA d'Electron porte « Windows NT ».
  if (nav.platform.startsWith("Win") || /Windows/.test(nav.userAgent)) return "windows";
  return null;
}

/**
 * À appeler avant le premier rendu : `<html>` porte l'attribut dès le premier
 * paint, sans saut de mise en page. Pose aussi la bande de déplacement du
 * haut de fenêtre, une fois, en premier enfant de `<body>` : Chromium applique
 * les régions de déplacement dans l'ordre du document, donc tout ce qui vient
 * après peut s'y découper.
 */
export function applyNativeTitlebar(doc: Document = document): NativeTitlebar | null {
  const titlebar = nativeTitlebarFor(nativeBridge(), doc.defaultView?.navigator ?? navigator);
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
