/**
 * Le libellé d'un raccourci Cmd/Ctrl + touche dans une infobulle : « ⌘B »
 * sur Mac (les raccourcis de la console acceptent Cmd), « Ctrl B » ailleurs.
 * Le navigateur et la coque native lisent la même plateforme.
 */
export function shortcutLabel(key: string, nav: { platform: string; userAgent: string } | undefined = globalThis.navigator): string {
  const apple = !!nav && (/^(Mac|iPhone|iPad)/.test(nav.platform) || /Macintosh|iPhone|iPad/.test(nav.userAgent));
  return apple ? `⌘${key}` : `Ctrl ${key}`;
}
