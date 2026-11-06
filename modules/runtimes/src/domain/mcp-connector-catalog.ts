/**
 * Le catalogue des connecteurs MCP qu'openedbot propose en un clic.
 *
 * Seulement des serveurs DISTANTS et OFFICIELS, hébergés par l'éditeur, qui
 * acceptent un client générique sans application inscrite à l'avance :
 * découverte OAuth (RFC 9728 / RFC 8414), inscription dynamique du client
 * (DCR, RFC 7591) et PKCE. C'est le seul mode que le flux de l'hôte joue
 * aujourd'hui : il désactive le CIMD dès que le retour passe par openedbot.
 *
 * Vérifié le 2026-10-31 par une sonde de découverte sans jeton (aucun
 * `/register` appelé) et par la documentation de chaque éditeur. « DCR »
 * veut donc dire « annoncé », pas « testé de bout en bout ». Les éditeurs
 * qui filtrent les clients (Figma, Vercel, Dropbox), leurs URL de retour
 * (ClickUp, Intercom) ou qui exigent une application inscrite (GitHub,
 * Slack, Google, Microsoft…) n'y sont PAS : un bouton « Connecter » qui
 * échoue chez eux serait pire que pas de bouton.
 *
 * L'éditeur de paiement que la facturation utilise n'y est pas non plus,
 * bien qu'il accepte la DCR : le cœur ne le nomme jamais
 * (`tests/scripts/payment-provider-contract.ts`), il appartient au plug-in.
 *
 * Le catalogue se limite à Notion, Linear et Cloudflare (décision de
 * l'opérateur, 2026-11-04). Un serveur d'un éditeur retiré déjà connecté sur
 * un hôte n'est pas touché : il apparaît comme un serveur ajouté à la main.
 *
 * L'identifiant est aussi le nom du serveur sur l'hôte : il suit la grammaire
 * des noms MCP de l'hôte et ne change jamais, sinon un serveur déjà connecté
 * ne serait plus reconnu comme venant du catalogue.
 */

export const MCP_CONNECTOR_CATALOG_VERSION = "2026-10-31";

export type McpConnectorCategory = "docs" | "dev";

export type McpConnectorEntry = {
  /** Nom du serveur sur l'hôte, stable : `^[a-z0-9][a-z0-9_-]{0,63}$`. */
  id: string;
  /** Nom de l'éditeur, tel qu'il l'écrit. */
  name: string;
  /** Endpoint MCP exact (streamable HTTP), jamais une URL legacy `/sse`. */
  url: string;
  category: McpConnectorCategory;
  /** Seul mode du catalogue pour l'instant : inscription dynamique du client. */
  auth: "dcr";
  /** Une réserve à dire avant de connecter (plan, administrateur), ou rien. */
  note: "workspaceAdmin" | null;
  /** Date de la dernière vérification, ISO. */
  verifiedAt: string;
  /** La page de l'éditeur qui décrit ce serveur. */
  source: string;
};

const VERIFIED_AT = MCP_CONNECTOR_CATALOG_VERSION;

export const MCP_CONNECTOR_CATALOG: readonly McpConnectorEntry[] = [
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", category: "docs", auth: "dcr", note: "workspaceAdmin", verifiedAt: VERIFIED_AT, source: "https://developers.notion.com/docs/mcp" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", category: "docs", auth: "dcr", note: null, verifiedAt: VERIFIED_AT, source: "https://linear.app/docs/mcp" },
  { id: "cloudflare", name: "Cloudflare", url: "https://mcp.cloudflare.com/mcp", category: "dev", auth: "dcr", note: null, verifiedAt: VERIFIED_AT, source: "https://developers.cloudflare.com/agents/model-context-protocol/" },
];

export function mcpConnectorEntry(id: string): McpConnectorEntry | null {
  return MCP_CONNECTOR_CATALOG.find((entry) => entry.id === id) ?? null;
}

/** Ce que le volet d'un bot sait d'un serveur MCP de son profil. */
type ProfileServer = { name: string; enabled: boolean };

/**
 * Les entrées du catalogue qui restent à proposer pour ce bot : celles que son
 * profil ne porte pas encore. Une entrée que le profil porte (activée ou non)
 * vit dans la liste des serveurs du bot, avec sa bascule : la proposer aussi
 * au catalogue la montrerait deux fois. Une liste `null` (profil illisible)
 * ne propose RIEN : on ne sait pas ce qui est déjà là.
 */
export function mcpCatalogOffer(
  profileServers: readonly ProfileServer[] | null,
  catalog: readonly McpConnectorEntry[] = MCP_CONNECTOR_CATALOG,
): McpConnectorEntry[] {
  if (profileServers === null) return [];
  const present = new Set(profileServers.map((server) => server.name));
  return catalog.filter((entry) => !present.has(entry.id));
}

/**
 * L'entrée racine de l'hôte peut-elle servir à cette entrée du catalogue ?
 * Même nom, même endpoint (à la barre finale près), en OAuth. Un serveur du
 * même nom ajouté à la main vers une autre adresse ne se remplace JAMAIS en
 * silence : c'est une décision de l'opérateur, pas du bouton.
 */
export function mcpCatalogRootMatch(
  entry: McpConnectorEntry,
  server: { endpoint: string | null; auth: "none" | "header" | "oauth" },
): "same" | "conflict" {
  const strip = (url: string) => url.replace(/\/+$/, "");
  return server.endpoint !== null && strip(server.endpoint) === strip(entry.url) && server.auth === "oauth"
    ? "same"
    : "conflict";
}
