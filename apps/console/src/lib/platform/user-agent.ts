/**
 * Lecture grossière d'un `User-Agent` pour l'écran « Sécurité du compte » :
 * « Safari · iPhone » plutôt que la chaîne brute. Pur, sans dépendance,
 * volontairement approximatif : un faux négatif retombe sur l'UA brut
 * tronqué côté écran, jamais sur une erreur.
 *
 * Parsing côté client, pas serveur : l'API stocke et renvoie l'UA brut sans
 * y toucher.
 */
export type DeviceLabel = { browser: string | null; platform: string | null };

function detectBrowser(userAgent: string): string | null {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/CriOS\//.test(userAgent)) return "Chrome";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  // Safari : présent aussi dans l'UA de Chrome/Edge, donc testé en dernier.
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
