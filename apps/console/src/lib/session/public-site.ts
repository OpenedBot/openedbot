/**
 * The public site (showcase) lives outside the console. Its
 * address is a build setting, `VITE_PUBLIC_SITE_URL` (or
 * `window.__OPENEDBOT_PUBLIC_SITE_URL__` set by the host), never inferred from the host
 * that serves the console: the same build behaves the same on the console
 * host and on the bare domain during the transition. Empty (the default, a
 * solo instance): no outbound link, the brand returns to the application.
 */
declare global {
  interface Window { __OPENEDBOT_PUBLIC_SITE_URL__?: string }
}

/** Absolute `http(s)` address of the public site, without a trailing `/`; `null` otherwise. */
export function publicSiteUrl(raw: string | undefined = readSetting()): string | null {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readSetting(): string | undefined {
  return globalThis.window?.__OPENEDBOT_PUBLIC_SITE_URL__ ?? import.meta.env?.VITE_PUBLIC_SITE_URL;
}
