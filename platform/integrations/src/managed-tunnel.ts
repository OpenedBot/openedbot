/**
 * OHB-75 : le compte Cloudflare d'openedbot qui héberge les tunnels gérés.
 *
 * Lu par l'API (provisioning) et par le worker (réconciliation de l'état des
 * tunnels). Une seule variable, comme STORAGE_URL ou EMAIL_URL :
 * `OPENEDBOT_MANAGED_TUNNEL_URL=cloudflare://<api-token>@<account-id>/<zone-id>[?suffix=rt.openedbot.app]`.
 * Absente, la voie « tunnel géré par openedbot » n'existe pas, sans erreur au
 * démarrage, parce qu'un déploiement sans compte Cloudflare est un déploiement
 * valide. Présente mais mal formée, le démarrage échoue sans jamais citer la
 * valeur (le jeton en fait partie).
 */
export type ManagedTunnelConfig = {
  accountId: string;
  apiToken: string;
  zoneId: string;
  /** Suffixe DNS des hostnames gérés, sans point initial (`rt.openedbot.app`). */
  hostSuffix: string;
};

export const DEFAULT_MANAGED_TUNNEL_SUFFIX = "rt.openedbot.app";

const SUFFIX_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function readManagedTunnelConfig(env: Record<string, string | undefined>): ManagedTunnelConfig | null {
  const raw = env.OPENEDBOT_MANAGED_TUNNEL_URL?.trim();
  if (!raw) return null;
  const invalid = () => new Error("OPENEDBOT_MANAGED_TUNNEL_URL must look like cloudflare://<api-token>@<account-id>/<zone-id>[?suffix=rt.openedbot.app].");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  const apiToken = safeDecode(url.username);
  const accountId = url.hostname;
  const zoneId = url.pathname.replace(/^\/+|\/+$/g, "");
  if (url.protocol !== "cloudflare:" || url.password || url.port || !apiToken || !accountId || !zoneId || zoneId.includes("/")) throw invalid();
  const hostSuffix = (url.searchParams.get("suffix")?.trim() || DEFAULT_MANAGED_TUNNEL_SUFFIX).toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!SUFFIX_PATTERN.test(hostSuffix)) throw new Error("OPENEDBOT_MANAGED_TUNNEL_URL: suffix must be a bare DNS suffix such as rt.openedbot.app.");
  return { accountId, apiToken, zoneId, hostSuffix };
}

/** The URL form of a managed tunnel account, the token percent-encoded. */
export function managedTunnelUrl(config: { accountId: string; apiToken: string; zoneId: string; hostSuffix?: string }): string {
  const suffix = config.hostSuffix && config.hostSuffix !== DEFAULT_MANAGED_TUNNEL_SUFFIX ? `?suffix=${encodeURIComponent(config.hostSuffix)}` : "";
  return `cloudflare://${encodeURIComponent(config.apiToken)}@${config.accountId}/${config.zoneId}${suffix}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
