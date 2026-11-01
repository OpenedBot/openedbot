import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { connectedMcpPluginNames } from "@/lib/runtime/mcp-plugins";
import { api, queryKeys } from "../api";
import { useSecondaryReadsReady } from "../shell/after-first-paint";

/**
 * Les serveurs MCP que l'hôte sert réellement aux runs, pour la coloration du
 * composer.
 *
 * Deux bornes, imposées par la route qui les porte
 * (`GET /api/runtime/integrations/mcp`) :
 *
 * - elle est réservée à `owner` / `admin`, d'où le `enabled` sur le rôle. Un
 *   membre ne voit donc AUCUNE coloration : c'est une aide de lecture, pas une
 *   capacité, et rien d'autre ne change pour lui ;
 * - elle démarre un interpréteur sur l'hôte du client. Le cache est donc long
 *   et la requête ne se rejoue ni au focus de fenêtre, ni sur échec : ouvrir
 *   dix conversations ne doit pas coûter dix sondes au VPS.
 *
 * Un serveur MCP branché depuis les réglages est visible ici dès que le
 * panneau connecteurs a rafraîchi cette même clé de cache : sinon, à la
 * péremption ci-dessous.
 */
const MCP_STALE_MS = 5 * 60_000;

export function useConnectedMcpPlugins(role: string | undefined): readonly string[] {
  const secondaryReady = useSecondaryReadsReady();
  const query = useQuery({
    queryKey: queryKeys.runtimeMcp,
    queryFn: api.runtimeMcp,
    enabled: (role === "owner" || role === "admin") && secondaryReady,
    staleTime: MCP_STALE_MS,
    gcTime: MCP_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return useMemo(
    () => connectedMcpPluginNames(query.data?.servers ?? []),
    [query.data?.servers],
  );
}
