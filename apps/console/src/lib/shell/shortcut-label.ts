/**
 * The label of a Cmd/Ctrl + key shortcut in a tooltip: « ⌘B »
 * on Mac (the console shortcuts accept Cmd), « Ctrl B » elsewhere.
 * The browser and the native shell read the same platform.
 */
export function shortcutLabel(key: string, nav: { platform: string; userAgent: string } | undefined = globalThis.navigator): string {
  const apple = !!nav && (/^(Mac|iPhone|iPad)/.test(nav.platform) || /Macintosh|iPhone|iPad/.test(nav.userAgent));
  return apple ? `⌘${key}` : `Ctrl ${key}`;
}
