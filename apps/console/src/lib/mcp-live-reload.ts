import { useQuery } from "@tanstack/react-query";
import { runtimesQueryOptions } from "./api";

/**
 * La feature de lien d'un hôte dont le gateway recharge ses serveurs MCP tout
 * seul : il réconcilie sa configuration à chaque tour de maintenance (60 s) et
 * une conversation ouverte reprend ses outils entre deux tours. Un geste MCP
 * (connecter, déconnecter, autoriser, basculer) n'y demande plus de
 * redémarrage du gateway. Un hôte plus ancien ne l'annonce pas : le
 * redémarrage reste demandé, comme avant.
 */
export const MCP_LIVE_RELOAD_FEATURE = "mcp_live_reload";

export function hasMcpLiveReload(features: readonly string[] | null | undefined): boolean {
  return Boolean(features?.includes(MCP_LIVE_RELOAD_FEATURE));
}

/** `true` quand le runtime de l'espace annonce `mcp_live_reload`. Faux tant qu'il n'est pas lu. */
export function useMcpLiveReload(enabled = true): boolean {
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled });
  return hasMcpLiveReload(runtimes.data?.runtimes[0]?.linkFeatures);
}
