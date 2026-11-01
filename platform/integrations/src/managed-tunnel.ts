/**
 * OHB-75 : le compte Cloudflare d'openedbot qui héberge les tunnels gérés.
 *
 * Lu par l'API (provisioning) et par le worker (réconciliation de l'état des
 * tunnels). Les quatre valeurs vont ensemble : une seule absente et la voie
 * « tunnel géré par openedbot » n'existe pas, sans erreur au démarrage, parce qu'un
 * déploiement sans compte Cloudflare est un déploiement valide.
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
  const accountId = env.OHB_CF_ACCOUNT_ID?.trim() ?? "";
  const apiToken = env.OHB_CF_API_TOKEN?.trim() ?? "";
  const zoneId = env.OHB_CF_ZONE_ID?.trim() ?? "";
  if (!accountId || !apiToken || !zoneId) return null;
  const hostSuffix = (env.OHB_MANAGED_TUNNEL_SUFFIX?.trim() || DEFAULT_MANAGED_TUNNEL_SUFFIX).toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!SUFFIX_PATTERN.test(hostSuffix)) throw new Error("OHB_MANAGED_TUNNEL_SUFFIX must be a bare DNS suffix such as rt.openedbot.app.");
  return { accountId, apiToken, zoneId, hostSuffix };
}
