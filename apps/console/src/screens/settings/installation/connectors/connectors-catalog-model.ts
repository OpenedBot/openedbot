import type { BotDto, BotFaceSpec, RuntimeHostProfileDto, RuntimeIntegrationMcpServerDto, RuntimeProfileMcpServerDto } from "@openedbot/contracts-api";
import {
  mcpCatalogRootMatch,
  mcpConnectorEntry,
  type McpConnectorCategory,
  type McpConnectorEntry,
} from "@openedbot/runtimes/domain/mcp-connector-catalog";
import type { MessageKey } from "../../../../lib/i18n";
import { RELAY_FEATURE_MCP_OAUTH_PROFILE, RELAY_FEATURE_MCP_PROFILE_DISCONNECT } from "@openedbot/contracts-connector/features";

/**
 * The rules of the Settings › Connectors page, without React: what shows
 * in which section, what the search keeps, and who can « Ajouter ».
 * Exported so they can be tested without mounting the screen.
 */

/** « À la une », in this order. The other entries live in their category. */
export const FEATURED_CONNECTOR_IDS: readonly string[] = ["notion", "linear", "cloudflare"];

export const CATEGORY_ORDER: readonly McpConnectorCategory[] = ["docs", "dev"];

export const CATEGORY_LABEL: Record<McpConnectorCategory, MessageKey> = {
  docs: "mcpCatalog.categoryDocs",
  dev: "mcpCatalog.categoryDev",
};

/** A catalog entry's sentence. An entry with no sentence shows none. */
const DESCRIPTION: Record<string, MessageKey> = {
  notion: "mcpCatalog.descriptionNotion",
  linear: "mcpCatalog.descriptionLinear",
  cloudflare: "mcpCatalog.descriptionCloudflare",
};

export function connectorDescriptionKey(id: string): MessageKey | null {
  return DESCRIPTION[id] ?? null;
}

/** Search: name and description, case-insensitive, with stray spaces stripped. */
export function matchesQuery(item: { name: string; description?: string | null }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return item.name.toLocaleLowerCase().includes(needle)
    || (item.description ?? "").toLocaleLowerCase().includes(needle);
}

export type CatalogSection = { key: "featured" | McpConnectorCategory; entries: McpConnectorEntry[] };

/**
 * « À la une » then one section per category. An entry appears only ONCE:
 * featured if it is there, otherwise in its category. A section the
 * search empties disappears, and not only its content.
 */
export function catalogSections(
  catalog: readonly McpConnectorEntry[],
  describe: (entry: McpConnectorEntry) => string,
  query: string,
  /** The entries already in « Connectés »: they are not shown twice. */
  connected: ReadonlySet<string> = new Set(),
): CatalogSection[] {
  const kept = catalog.filter((entry) =>
    !connected.has(entry.id) && matchesQuery({ name: entry.name, description: describe(entry) }, query));
  const featured = FEATURED_CONNECTOR_IDS
    .map((id) => kept.find((entry) => entry.id === id))
    .filter((entry): entry is McpConnectorEntry => entry !== undefined);
  const sections: CatalogSection[] = featured.length > 0 ? [{ key: "featured", entries: featured }] : [];
  for (const category of CATEGORY_ORDER) {
    const entries = kept.filter((entry) => entry.category === category && !FEATURED_CONNECTOR_IDS.includes(entry.id));
    if (entries.length > 0) sections.push({ key: category, entries });
  }
  return sections;
}

/** Why « Ajouter » / « Connecter » is not offered, or `null` if it is. */
export type McpConnectBlocker = "profile" | "role" | "host" | null;

/**
 * The same gate as the route `POST /integrations/mcp/connectors/:id/connect`:
 * an operator who can write, a host that announces `mcp_oauth_profile`, and
 * (for a given bot) a Hermes profile. While the host's features are not
 * read, nothing blocks: the route will refuse itself if needed.
 */
export function mcpConnectBlocker(input: {
  hasProfile?: boolean;
  writable: boolean;
  featuresPending: boolean;
  features: readonly string[];
}): McpConnectBlocker {
  if (input.hasProfile === false) return "profile";
  if (!input.writable) return "role";
  if (input.featuresPending || input.features.includes(RELAY_FEATURE_MCP_OAUTH_PROFILE)) return null;
  return "host";
}

export type BotPickerOption = { bot: BotDto; disabled: "profile" | "taken" | null };

/**
 * The bots « Connecter X à quel bot ? » offers. An archived bot or one in the
 * trash is not there; a bot with no Hermes profile is, greyed out with its
 * reason: the MCP token lives in a profile's home, the root serves no
 * bot. So is a bot whose profile already carries another server under the
 * entry's name (`catalogNameTaken`): the host would authorize that one, and
 * the connection route refuses it. The connectable bots first, then by name.
 */
export function botPickerOptions(
  bots: readonly BotDto[],
  taken: (bot: BotDto) => boolean = () => false,
): BotPickerOption[] {
  return bots
    .filter((bot) => bot.archivedAt === null && !bot.deletedAt)
    .map((bot): BotPickerOption => ({ bot, disabled: !bot.hermesProfile ? "profile" : taken(bot) ? "taken" : null }))
    .sort((left, right) =>
      Number(left.disabled !== null) - Number(right.disabled !== null)
      || left.bot.name.localeCompare(right.bot.name));
}

/**
 * The catalog entry this host server IS (same name, same
 * endpoint, OAuth), or `null` for a server added by hand. Only the
 * latter keep authorization at the root: a catalog server
 * connects bot by bot, in the profile that will read its token.
 */
export function catalogEntryOfServer(
  server: Pick<RuntimeIntegrationMcpServerDto, "name" | "endpoint" | "auth">,
): McpConnectorEntry | null {
  const entry = mcpConnectorEntry(server.name);
  if (!entry) return null;
  return mcpCatalogRootMatch(entry, { endpoint: server.endpoint, auth: server.auth }) === "same" ? entry : null;
}

/**
 * The catalog entry a bot's profile server IS. With the host's facts, the
 * root's rule (`catalogEntryOfServer`): same name, same endpoint, OAuth; a
 * server imported by hand under a catalog name toward another address is not
 * that entry. An older host gives only the name: recognized by it, as before.
 */
export function catalogEntryOfProfileServer(
  server: Pick<RuntimeProfileMcpServerDto, "name" | "endpoint" | "auth">,
): McpConnectorEntry | null {
  if (server.auth === undefined) return mcpConnectorEntry(server.name);
  return catalogEntryOfServer({ name: server.name, endpoint: server.endpoint ?? null, auth: server.auth });
}

/**
 * The profile carries a server under the entry's name that the host
 * describes as ANOTHER server (another address, another auth mode, no
 * address): connecting the entry to this bot would authorize that one, so
 * it is refused (`MCP_SERVER_NAME_TAKEN`) and never offered. An older host
 * does not describe it: not taken, as before.
 */
export function catalogNameTaken(
  servers: readonly Pick<RuntimeProfileMcpServerDto, "name" | "endpoint" | "auth">[] | null | undefined,
  entry: McpConnectorEntry,
): boolean {
  const server = servers?.find((candidate) => candidate.name === entry.id);
  return Boolean(server && server.auth !== undefined && catalogEntryOfProfileServer(server)?.id !== entry.id);
}

/** A catalog entry a bot's sheet offers, or shows greyed out with why. */
export type BotCatalogOffer = { entry: McpConnectorEntry; taken: boolean };

/**
 * The bot sheet's « Catalogue »: the entries the profile does not carry,
 * plus, greyed out, those whose name another server of the profile takes
 * (the same rule as Settings' picker). An entry the profile carries as itself
 * lives in the bot's server list instead. A list `null` (unreadable profile)
 * offers nothing: what is already there is unknown.
 */
export function botCatalogOffer(
  servers: readonly Pick<RuntimeProfileMcpServerDto, "name" | "endpoint" | "auth">[] | null,
  catalog: readonly McpConnectorEntry[],
): BotCatalogOffer[] {
  if (servers === null) return [];
  return catalog.flatMap((entry): BotCatalogOffer[] => {
    if (catalogNameTaken(servers, entry)) return [{ entry, taken: true }];
    return servers.some((server) => server.name === entry.id) ? [] : [{ entry, taken: false }];
  });
}

/**
 * What a bot's profile server is worth, from what the host PROVES, never from
 * the entry alone (a new profile is cloned from the root config, the per-bot
 * switch copies the root entry, both without a token):
 * - `connected`: an OAuth server whose token file is in the profile's home;
 * - `authorize`: an OAuth server whose token the host knows absent (deleted,
 *   never obtained, failed half-way): inert until « Autoriser »;
 * - `unknown`: the host does not say (older edge-setup, unchecked, another
 *   auth mode): rendered exactly as before the host could say.
 */
export type ProfileServerState = "connected" | "authorize" | "unknown";

export function profileServerState(
  server: Pick<RuntimeProfileMcpServerDto, "auth" | "oauthTokenPresent">,
): ProfileServerState {
  if (server.auth !== "oauth") return "unknown";
  if (server.oauthTokenPresent === true) return "connected";
  return server.oauthTokenPresent === false ? "authorize" : "unknown";
}

/** A bot whose profile carries a catalog entry, and what that entry is worth. */
export type ConnectorBotLink = {
  botId: string;
  name: string;
  face: BotFaceSpec | null;
  profile: string;
  enabled: boolean;
  state: ProfileServerState;
};

/**
 * A catalog entry some bot's profile carries, or whose root token is on
 * the host's disk (which a profiled bot's runs do not read).
 */
export type ConnectorConnection = { entry: McpConnectorEntry; bots: ConnectorBotLink[]; rootToken: boolean };

/**
 * Every catalog entry a bot's profile carries (whatever it is worth), or
 * whose root holds a token. The root's server with no token is only a model
 * for the profiles: it does not make a connection of it. What counts as
 * connected is `connectedBotLinks` / `isListedConnection`: every screen reads
 * them, none re-derives.
 */
export function catalogConnections(input: {
  catalog: readonly McpConnectorEntry[];
  profiles: readonly RuntimeHostProfileDto[] | null;
  bots: readonly BotDto[] | null;
  rootServers: readonly RuntimeIntegrationMcpServerDto[] | null;
}): ConnectorConnection[] {
  const bots = new Map((input.bots ?? []).map((bot) => [bot.id, bot]));
  const connections: ConnectorConnection[] = [];
  for (const entry of input.catalog) {
    const links: ConnectorBotLink[] = [];
    for (const profile of input.profiles ?? []) {
      const server = (profile.mcpServers ?? []).find((candidate) => catalogEntryOfProfileServer(candidate)?.id === entry.id);
      // A profile that nothing links to a bot is not disconnected from here.
      if (!server || !profile.importedBotId) continue;
      links.push({
        botId: profile.importedBotId,
        name: bots.get(profile.importedBotId)?.name ?? profile.displayName,
        face: bots.get(profile.importedBotId)?.face ?? null,
        profile: profile.name,
        enabled: server.enabled,
        state: profileServerState(server),
      });
    }
    links.sort((left, right) => left.name.localeCompare(right.name));
    const root = (input.rootServers ?? []).find((server) => catalogEntryOfServer(server)?.id === entry.id);
    const rootToken = root?.oauthTokenPresent === true;
    if (links.length > 0 || rootToken) connections.push({ entry, bots: links, rootToken });
  }
  return connections;
}

/**
 * The bots connected to this entry: proven, or unknown from a host that does
 * not say (today's reading). Never one whose token is known absent.
 */
export function connectedBotLinks(connection: ConnectorConnection): ConnectorBotLink[] {
  return connection.bots.filter((link) => link.state !== "authorize");
}

/** The bots that carry the entry without its token: « À autoriser ». */
export function botLinksToAuthorize(connection: ConnectorConnection): ConnectorBotLink[] {
  return connection.bots.filter((link) => link.state === "authorize");
}

/**
 * « Connectés » lists an entry with at least one connected bot, or a root
 * token. Bots that only carry it without a token do not make it connected:
 * the entry stays offered in the catalog.
 */
export function isListedConnection(connection: ConnectorConnection): boolean {
  return connectedBotLinks(connection).length > 0 || connection.rootToken;
}

/** Why « Déconnecter » is not offered, or `null` if it is. */
export type McpDisconnectBlocker = "role" | "host" | null;

/** The gate of `DELETE /integrations/mcp/connectors/:id/connections/:botId`. */
export function mcpDisconnectBlocker(input: {
  writable: boolean;
  featuresPending: boolean;
  features: readonly string[];
}): McpDisconnectBlocker {
  if (!input.writable) return "role";
  if (input.featuresPending || input.features.includes(RELAY_FEATURE_MCP_PROFILE_DISCONNECT)) return null;
  return "host";
}
