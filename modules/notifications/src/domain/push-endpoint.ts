/**
 * Destinations Web Push acceptées. Le worker POSTe vers l'endpoint fourni par
 * le navigateur : une URL arbitraire en ferait une requête vers le réseau
 * interne (SSRF). On n'accepte donc que les services Push des navigateurs,
 * en HTTPS sur le port par défaut, sans identifiants dans l'URL.
 *
 * - Chrome, Edge Android, Opera, Samsung : `fcm.googleapis.com` ;
 * - Firefox : `*.push.services.mozilla.com` ;
 * - Edge (Windows) : `*.notify.windows.com` (WNS) ;
 * - Safari : `*.push.apple.com` (Apple demande d'autoriser ce suffixe).
 */
const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com"] as const;
const PUSH_SERVICE_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type PushEndpointPolicy = {
  /** Serveur push simulé (`make e2e-push`) : opt-in explicite, jamais en production. */
  allowLoopback: boolean;
};

export function isAllowedPushEndpoint(endpoint: string, policy: PushEndpointPolicy): boolean {
  const url = parseUrl(endpoint);
  if (!url || url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname;
  if (policy.allowLoopback && LOOPBACK_HOSTS.has(host)) return true;
  if (url.port !== "") return false;
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed)
    || PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

export function isLoopbackPushEndpoint(endpoint: string): boolean {
  const url = parseUrl(endpoint);
  return url !== null && LOOPBACK_HOSTS.has(url.hostname);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
