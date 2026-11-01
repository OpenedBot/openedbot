/**
 * Détection d’affichage (mode autonome, iOS) : hors React pour que les écrans
 * et les tests partagent la même règle. La console n'est plus une PWA
 * installable ; ces lectures servent seulement à adapter la mise en page.
 */

type IosNavigator = Navigator & { standalone?: boolean };
type LegacyIosWindow = Window & { MSStream?: unknown };

/** Réglages et leurs sous-pages. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

const STANDALONE_DISPLAY_MODES = [
  "(display-mode: standalone)",
  "(display-mode: fullscreen)",
  "(display-mode: minimal-ui)",
] as const;

/** `display-mode: standalone` (ou voisin) / Safari iOS (`navigator.standalone`). */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (STANDALONE_DISPLAY_MODES.some((query) => window.matchMedia(query).matches)) return true;
  return Boolean((navigator as IosNavigator).standalone);
}

/**
 * iPhone / iPad / iPod, hors IE/Edge iOS (`MSStream`).
 * iPadOS 13+ se présente comme Macintosh + `maxTouchPoints > 1`.
 */
export function isIosDevice(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if ((window as LegacyIosWindow).MSStream) return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}
