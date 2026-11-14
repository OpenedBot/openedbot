import type {
  RuntimeIntegrationMcpCatalogEntryDto,
  RuntimeIntegrationMcpServerDto,
} from "@openedbot/contracts-api";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../../../lib/api";
import { catalogEntryOfServer } from "./connectors-catalog-model";

/**
 * What a bot's MCP connection or disconnection changes, the same set for every
 * place that plays it: the host's servers and inventory, the gateway's
 * pending restart, the profiles (« Connectés » reads the bots' connections
 * there) and, when the gesture targets one, that bot's capabilities.
 */
export function invalidateMcpConnectionReads(queryClient: QueryClient, botId?: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeMcp });
  void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeIntegrations });
  void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
  void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
  if (botId) void queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(botId) });
}

/**
 * What a server row says about its state, and the gesture it offers.
 *
 * An `oauth` server with no token is REGISTERED, not usable: the upstream
 * client refuses to open a session and the gateway never lists its tools.
 * Calling it "carried by the platform" would be both true and misleading; we
 * state the nuance, and we offer authorization when the host knows how to play it.
 *
 * Except for a server from openedbot's catalog: its token must live in a
 * bot's profile, and authorizing it at the root would serve none of them. It
 * connects bot by bot (« Ajouter » or the bot's MCP panel), never from here.
 */
export function serverState(server: RuntimeIntegrationMcpServerDto): {
  tone: "warning" | "neutral" | "success";
  key: "mcpUnreachable" | "mcpOauthRequired" | "mcpNotOnPlatform" | "mcpOauthAuthorized" | "mcpOnPlatform";
  authorizable: boolean;
} {
  if (server.unreachable) return { tone: "warning", key: "mcpUnreachable", authorizable: false };
  if (server.auth === "oauth" && server.oauthTokenPresent === false) {
    return { tone: "warning", key: "mcpOauthRequired", authorizable: catalogEntryOfServer(server) === null };
  }
  if (!server.platformEnabled) return { tone: "neutral", key: "mcpNotOnPlatform", authorizable: false };
  if (server.auth === "oauth" && server.oauthTokenPresent === true) {
    return { tone: "success", key: "mcpOauthAuthorized", authorizable: false };
  }
  return { tone: "success", key: "mcpOnPlatform", authorizable: false };
}

/**
 * The catalog filter: on the name and on the description, case-insensitive.
 *
 * Exported so it can be tested without mounting the screen: it is the only rule that
 * decides what stays on screen when one types.
 */
export function filterCatalog(
  catalog: readonly RuntimeIntegrationMcpCatalogEntryDto[],
  query: string,
): readonly RuntimeIntegrationMcpCatalogEntryDto[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return catalog;
  return catalog.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle)
      || (entry.description ?? "").toLowerCase().includes(needle),
  );
}
