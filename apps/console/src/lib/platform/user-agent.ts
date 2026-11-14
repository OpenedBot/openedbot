/**
 * A rough read of a `User-Agent` for the « Sécurité du compte » screen:
 * « Safari · iPhone » rather than the raw string. Pure, no dependency,
 * deliberately approximate: a false negative falls back to the raw UA
 * truncated on the screen side, never to an error.
 *
 * Parsing on the client, not the server: the API stores and returns the raw UA without
 * touching it.
 */
export type DeviceLabel = { browser: string | null; platform: string | null };

function detectBrowser(userAgent: string): string | null {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/CriOS\//.test(userAgent)) return "Chrome";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  // Safari: also present in Chrome/Edge's UA, so tested last.
  if (/Version\/.+Safari\//.test(userAgent) || /Safari\//.test(userAgent)) return "Safari";
  return null;
}

function detectPlatform(userAgent: string): string | null {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android";
  if (/Mac OS X/.test(userAgent)) return "macOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

export function describeUserAgent(userAgent: string | null): DeviceLabel {
  if (!userAgent || userAgent.trim().length === 0) return { browser: null, platform: null };
  return { browser: detectBrowser(userAgent), platform: detectPlatform(userAgent) };
}
