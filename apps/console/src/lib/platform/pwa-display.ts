/**
 * Display detection (standalone mode, iOS): outside React so the screens
 * and the tests share the same rule. The console is no longer an installable
 * PWA; these reads only serve to adapt the layout.
 */

type IosNavigator = Navigator & { standalone?: boolean };
type LegacyIosWindow = Window & { MSStream?: unknown };

/** Settings and their subpages. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

const STANDALONE_DISPLAY_MODES = [
  "(display-mode: standalone)",
  "(display-mode: fullscreen)",
  "(display-mode: minimal-ui)",
] as const;

/** `display-mode: standalone` (or a neighbor) / Safari iOS (`navigator.standalone`). */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (STANDALONE_DISPLAY_MODES.some((query) => window.matchMedia(query).matches)) return true;
  return Boolean((navigator as IosNavigator).standalone);
}

/**
 * iPhone / iPad / iPod, excluding IE/Edge iOS (`MSStream`).
 * iPadOS 13+ presents itself as Macintosh + `maxTouchPoints > 1`.
 */
export function isIosDevice(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if ((window as LegacyIosWindow).MSStream) return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}
