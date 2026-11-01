import type {
  RuntimeIntegrationMcpCatalogEntryDto,
  RuntimeIntegrationMcpServerDto,
} from "@openedbot/contracts-api";
import { catalogEntryOfServer } from "./connectors-catalog-model";

/**
 * Ce qu'une ligne de serveur dit de son état, et le geste qu'elle propose.
 *
 * Un serveur `oauth` sans jeton est ENREGISTRÉ, pas utilisable : le client
 * amont refuse d'ouvrir une session et le gateway ne liste jamais ses outils.
 * Le dire « porté par la plateforme » serait vrai et trompeur à la fois ; on
 * dit la nuance, et on offre l'autorisation quand l'hôte la sait jouer.
 *
 * Sauf pour un serveur du catalogue d'openedbot : son jeton doit vivre dans le
 * profil d'un bot, et l'autoriser à la racine n'en servirait aucun. Il se
 * connecte bot par bot (« Ajouter » ou le volet MCP du bot), jamais d'ici.
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
 * Le filtre du catalogue : sur le nom et sur la description, sans casse.
 *
 * Exporté pour être éprouvé sans monter l'écran : c'est la seule règle qui
 * décide de ce qui reste à l'écran quand on tape.
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
