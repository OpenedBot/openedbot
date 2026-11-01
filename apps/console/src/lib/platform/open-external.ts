/**
 * Ouvrir une URL HORS de la fenêtre : l'écran de consentement Google, que
 * Google refuse de servir dans une webview embarquée (`disallowed_useragent`).
 *
 * Isolé dans son propre module pour que les tests remplacent CE module plutôt
 * que `window.open`. Un nouvel onglet ; s'il est bloqué, l'appelant montre le
 * lien.
 */

/** Rend `false` quand rien ne s'est ouvert (fenêtre bloquée), jamais une exception. */
export async function openExternal(url: string): Promise<boolean> {
  // Pas `noopener` dans les options : la spécification rend alors `null`
  // même quand l'onglet s'est ouvert, et l'écran montrerait toujours le lien
  // de secours (mesuré sous Playwright le 18-08). On coupe l'`opener` à la main
  // sur la poignée rendue : même isolation, et un `null` veut dire « bloqué ».
  const opened = globalThis.window?.open(url, "_blank");
  if (!opened) return false;
  try {
    opened.opener = null;
  } catch {
    // Une poignée déjà cross-origin : l'`opener` n'est plus accessible, et
    // c'est précisément ce qu'on voulait.
  }
  return true;
}

/**
 * Quitter la fenêtre pour une URL : le mode web navigue vers Google dans le
 * MÊME onglet et y revient par `returnTo`. Isolé ici pour la même raison que
 * `openExternal` : les tests remplacent `window.location.assign`, pas ce module.
 */
export function leaveTo(url: string): void {
  globalThis.window?.location.assign(url);
}
