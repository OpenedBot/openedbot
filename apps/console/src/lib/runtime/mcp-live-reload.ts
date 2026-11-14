import { useQuery } from "@tanstack/react-query";
import { runtimesQueryOptions } from "../api";
import { RELAY_FEATURE_MCP_LIVE_RELOAD } from "@openedbot/contracts-connector/features";

export function hasMcpLiveReload(features: readonly string[] | null | undefined): boolean {
  return Boolean(features?.includes(RELAY_FEATURE_MCP_LIVE_RELOAD));
}

/** `true` when the workspace runtime advertises `mcp_live_reload`. False until it has been read. */
export function useMcpLiveReload(enabled = true): boolean {
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled });
  return hasMcpLiveReload(runtimes.data?.runtimes[0]?.linkFeatures);
}
