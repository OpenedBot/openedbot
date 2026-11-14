import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { connectedMcpPluginNames, profileMcpPluginNames } from "@/lib/runtime/mcp-plugins";
import { api, queryKeys } from "../api";
import { useSecondaryReadsReady } from "../shell/after-first-paint";

/**
 * The MCP servers the host actually serves to runs, for coloring the
 * composer.
 *
 * Two bounds, imposed by the route that carries them
 * (`GET /api/runtime/integrations/mcp`):
 *
 * - it is reserved to `owner` / `admin`, hence `enabled` on the role. A
 *   member therefore sees NO coloring: it is a reading aid, not a
 *   capability, and nothing else changes for them;
 * - it starts an interpreter on the client's host. The cache is therefore long
 *   and the request is not replayed on window focus, nor on failure: opening
 *   ten conversations must not cost ten probes to the VPS.
 *
 * With a bot's `profile`, its own servers win when the profile reading
 * describes them (`profileMcpPluginNames`); otherwise (older host, profile
 * not listed, read failed), the runtime-wide reading as before. Until that
 * profile reading is known, nothing is colored: showing the root's servers
 * first, then the bot's, would color words the bot cannot reach. Both reads
 * share the settings' cache keys; a failed read is kept like an answer: not
 * replayed when another conversation opens (`retryOnMount`), only once its
 * cache entry is gone or a settings gesture invalidates it.
 *
 * An MCP server connected from settings is visible here as soon as the
 * connectors panel has refreshed this same cache key: otherwise, at the
 * staleness below.
 */
const MCP_STALE_MS = 5 * 60_000;

export function useConnectedMcpPlugins(role: string | undefined, profile: string | null = null): readonly string[] {
  const secondaryReady = useSecondaryReadsReady();
  const allowed = (role === "owner" || role === "admin") && secondaryReady;
  const reads = { staleTime: MCP_STALE_MS, gcTime: MCP_STALE_MS, retry: false, retryOnMount: false, refetchOnWindowFocus: false } as const;
  const query = useQuery({ queryKey: queryKeys.runtimeMcp, queryFn: api.runtimeMcp, enabled: allowed, ...reads });
  const profiles = useQuery({
    queryKey: queryKeys.runtimeProfiles,
    queryFn: api.runtimeProfiles,
    enabled: allowed && profile !== null,
    ...reads,
  });
  const waiting = profile !== null && allowed && profiles.isPending;
  const own = profile === null ? undefined : profiles.data?.profiles.find((candidate) => candidate.name === profile);
  return useMemo(
    () => waiting ? NONE : profileMcpPluginNames(own) ?? connectedMcpPluginNames(query.data?.servers ?? []),
    [waiting, own, query.data?.servers],
  );
}

const NONE: readonly string[] = [];
