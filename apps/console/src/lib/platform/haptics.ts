/**
 * Retour haptique « fire-and-forget », sur le modèle de `shared/lib/platform/haptics.ts`
 * du template mobile : un no-op partout où le moteur ne l'expose pas, et
 * jamais une erreur.
 *
 * Le web n'a que `navigator.vibrate` (Chromium Android). Safari iOS ne
 * l'implémente pas : le geste y reste muet, comme dans un WebView sans module
 * natif. Gardé derrière `pointer: coarse` : un portable avec un moteur de
 * vibration branché ne doit pas bourdonner sous la souris.
 */
type VibratingNavigator = Navigator & { vibrate?: (pattern: number | number[]) => boolean };

function canVibrate(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (typeof (navigator as VibratingNavigator).vibrate !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

function vibrate(pattern: number | number[]): void {
  if (!canVibrate()) return;
  try {
    (navigator as VibratingNavigator).vibrate?.(pattern);
  } catch {
    // Un retour haptique qui échoue ne vaut jamais une exception.
  }
}

export const haptics = {
  /** Un contact léger : le panneau qui s'accroche, une ligne qui s'ouvre. */
  light: () => vibrate(8),
  /** Un changement de sélection : onglet, option, segment. */
  selection: () => vibrate(4),
  /** Une action aboutie : message envoyé, réglage enregistré. */
  success: () => vibrate([6, 40, 10]),
};
