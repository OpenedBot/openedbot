/**
 * Open a URL OUTSIDE the window: the Google consent screen, which
 * Google refuses to serve in an embedded webview (`disallowed_useragent`).
 *
 * Isolated in its own module so tests replace THIS module rather
 * than `window.open`. A new tab; if it is blocked, the caller shows the
 * link.
 */

/** Returns `false` when nothing opened (blocked window), never an exception. */
export async function openExternal(url: string): Promise<boolean> {
  // No `noopener` in the options: the specification then returns `null`
  // even when the tab did open, and the screen would always show the fallback
  // link (measured under Playwright on 18-08). We cut the `opener` by hand
  // on the returned handle: same isolation, and a `null` means « bloqué ».
  const opened = globalThis.window?.open(url, "_blank");
  if (!opened) return false;
  try {
    opened.opener = null;
  } catch {
    // A handle already cross-origin: the `opener` is no longer reachable, and
    // that is precisely what we wanted.
  }
  return true;
}

/**
 * Leave the window for a URL: web mode navigates to Google in the
 * SAME tab and comes back via `returnTo`. Isolated here for the same reason as
 * `openExternal`: tests replace `window.location.assign`, not this module.
 */
export function leaveTo(url: string): void {
  globalThis.window?.location.assign(url);
}
