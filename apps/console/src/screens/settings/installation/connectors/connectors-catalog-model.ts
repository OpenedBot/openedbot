import type { BotDto, BotFaceSpec, RuntimeHostProfileDto, RuntimeIntegrationMcpServerDto } from "@openedbot/contracts-api";
import {
  mcpCatalogRootMatch,
  mcpConnectorEntry,
  type McpConnectorCategory,
  type McpConnectorEntry,
} from "@openedbot/runtimes/domain/mcp-connector-catalog";
import type { MessageKey } from "../../../../lib/i18n";
import { RELAY_FEATURE_MCP_OAUTH_PROFILE, RELAY_FEATURE_MCP_PROFILE_DISCONNECT } from "@openedbot/contracts-connector/features";

/**
 * Les règles de la page Réglages › Connecteurs, sans React : ce qui s'affiche
 * dans quelle section, ce que la recherche garde, et qui peut « Ajouter ».
 * Exportées pour être éprouvées sans monter l'écran.
 */

/** « À la une », dans cet ordre. Les autres entrées vivent dans leur catégorie. */
export const FEATURED_CONNECTOR_IDS: readonly string[] = ["notion", "linear", "cloudflare"];

export const CATEGORY_ORDER: readonly McpConnectorCategory[] = ["docs", "dev"];

export const CATEGORY_LABEL: Record<McpConnectorCategory, MessageKey> = {
  docs: "mcpCatalog.categoryDocs",
  dev: "mcpCatalog.categoryDev",
};

/** La phrase d'une entrée du catalogue. Une entrée sans phrase n'en affiche pas. */
const DESCRIPTION: Record<string, MessageKey> = {
  notion: "mcpCatalog.descriptionNotion",
  linear: "mcpCatalog.descriptionLinear",
  cloudflare: "mcpCatalog.descriptionCloudflare",
};

export function connectorDescriptionKey(id: string): MessageKey | null {
  return DESCRIPTION[id] ?? null;
}

/** La recherche : nom et description, sans casse ni espaces parasites. */
export function matchesQuery(item: { name: string; description?: string | null }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return item.name.toLocaleLowerCase().includes(needle)
    || (item.description ?? "").toLocaleLowerCase().includes(needle);
}

export type CatalogSection = { key: "featured" | McpConnectorCategory; entries: McpConnectorEntry[] };

/**
 * « À la une » puis une section par catégorie. Une entrée n'apparaît qu'UNE
 * fois : à la une si elle y est, sinon dans sa catégorie. Une section que la
 * recherche vide disparaît, et non son seul contenu.
 */
export function catalogSections(
  catalog: readonly McpConnectorEntry[],
  describe: (entry: McpConnectorEntry) => string,
  query: string,
  /** Les entrées déjà dans « Connectés » : elles ne s'affichent pas deux fois. */
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

/** Pourquoi « Ajouter » / « Connecter » n'est pas offert, ou `null` s'il l'est. */
export type McpConnectBlocker = "profile" | "role" | "host" | null;

/**
 * La même porte que la route `POST /integrations/mcp/connectors/:id/connect` :
 * un opérateur qui peut écrire, un hôte qui annonce `mcp_oauth_profile`, et
 * (pour un bot donné) un profil Hermes. Tant que les features de l'hôte ne
 * sont pas lues, rien ne bloque : la route refusera elle-même au besoin.
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

export type BotPickerOption = { bot: BotDto; disabled: "profile" | null };

/**
 * Les bots que propose « Connecter X à quel bot ? ». Un bot archivé ou en
 * corbeille n'y est pas ; un bot sans profil Hermes y est, grisé avec sa
 * raison : le jeton MCP vit dans le home d'un profil, la racine ne sert aucun
 * bot. Les bots connectables d'abord, puis par nom.
 */
export function botPickerOptions(bots: readonly BotDto[]): BotPickerOption[] {
  return bots
    .filter((bot) => bot.archivedAt === null && !bot.deletedAt)
    .map((bot): BotPickerOption => ({ bot, disabled: bot.hermesProfile ? null : "profile" }))
    .sort((left, right) =>
      Number(left.disabled !== null) - Number(right.disabled !== null)
      || left.bot.name.localeCompare(right.bot.name));
}

/**
 * L'entrée du catalogue que ce serveur de l'hôte EST (même nom, même
 * endpoint, OAuth), ou `null` pour un serveur ajouté à la main. Seuls les
 * seconds gardent l'autorisation à la racine : un serveur du catalogue se
 * connecte bot par bot, dans le profil qui lira son jeton.
 */
export function catalogEntryOfServer(
  server: Pick<RuntimeIntegrationMcpServerDto, "name" | "endpoint" | "auth">,
): McpConnectorEntry | null {
  const entry = mcpConnectorEntry(server.name);
  if (!entry) return null;
  return mcpCatalogRootMatch(entry, { endpoint: server.endpoint, auth: server.auth }) === "same" ? entry : null;
}

/** Un bot dont le profil porte une entrée du catalogue. */
export type ConnectorBotLink = { botId: string; name: string; face: BotFaceSpec | null; profile: string; enabled: boolean };

/**
 * Une entrée du catalogue connectée quelque part : les bots dont le profil
 * la porte, et le jeton éventuel de la racine (que les runs d'un bot à profil
 * ne lisent pas, mais qui reste sur le disque de l'hôte).
 */
export type ConnectorConnection = { entry: McpConnectorEntry; bots: ConnectorBotLink[]; rootToken: boolean };

/**
 * « Connectés » : une ligne par entrée du catalogue qu'au moins un bot porte,
 * ou dont la racine détient un jeton. L'hôte n'inscrit un serveur du catalogue
 * dans un profil qu'une fois son jeton prouvé : la configuration du profil
 * suffit à dire « connecté ». Le serveur de la racine sans jeton n'est qu'un
 * modèle pour les profils : il n'en fait pas une connexion.
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
      const server = (profile.mcpServers ?? []).find((candidate) => candidate.name === entry.id);
      // Un profil que rien ne relie à un bot ne se déconnecte pas d'ici.
      if (!server || !profile.importedBotId) continue;
      links.push({
        botId: profile.importedBotId,
        name: bots.get(profile.importedBotId)?.name ?? profile.displayName,
        face: bots.get(profile.importedBotId)?.face ?? null,
        profile: profile.name,
        enabled: server.enabled,
      });
    }
    links.sort((left, right) => left.name.localeCompare(right.name));
    const root = (input.rootServers ?? []).find((server) => catalogEntryOfServer(server)?.id === entry.id);
    const rootToken = root?.oauthTokenPresent === true;
    if (links.length > 0 || rootToken) connections.push({ entry, bots: links, rootToken });
  }
  return connections;
}

/** Pourquoi « Déconnecter » n'est pas offert, ou `null` s'il l'est. */
export type McpDisconnectBlocker = "role" | "host" | null;

/** La porte de `DELETE /integrations/mcp/connectors/:id/connections/:botId`. */
export function mcpDisconnectBlocker(input: {
  writable: boolean;
  featuresPending: boolean;
  features: readonly string[];
}): McpDisconnectBlocker {
  if (!input.writable) return "role";
  if (input.featuresPending || input.features.includes(RELAY_FEATURE_MCP_PROFILE_DISCONNECT)) return null;
  return "host";
}
