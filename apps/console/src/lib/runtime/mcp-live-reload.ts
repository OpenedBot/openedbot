import { useQuery } from "@tanstack/react-query";
import { runtimesQueryOptions } from "../api";
import { RELAY_FEATURE_MCP_LIVE_RELOAD } from "@openedbot/contracts-connector/features";

export function hasMcpLiveReload(features: readonly string[] | null | undefined): boolean {
  return Boolean(features?.includes(RELAY_FEATURE_MCP_LIVE_RELOAD));
}

/** `true` quand le runtime de l'espace annonce `mcp_live_reload`. Faux tant qu'il n'est pas lu. */
export function useMcpLiveReload(enabled = true): boolean {
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled });
  return hasMcpLiveReload(runtimes.data?.runtimes[0]?.linkFeatures);
}
