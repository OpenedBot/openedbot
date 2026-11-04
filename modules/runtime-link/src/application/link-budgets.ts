import {
  MCP_INSTALL_TIMEOUT_MS,
  MCP_MUTATION_TIMEOUT_MS,
  PROFILE_MUTATION_TIMEOUT_MS,
  SKILLS_HUB_INSTALL_TIMEOUT_MS,
  TOOLSET_MUTATION_TIMEOUT_MS,
} from "@openedbot/hermes";

/**
 * Délai de première réponse du broker par famille de routes hôte. L'hôte ne
 * répond à une mutation qu'une fois la commande finie (un toolset réécrit la
 * config sous un Python froid, un ajout MCP sonde le serveur, une install
 * clone un dépôt) : le broker ne doit pas couper avant le budget que le client
 * Hermes s'accorde pour la même route. Ces budgets viennent donc du client,
 * jamais recopiés. Une route absente garde le délai par défaut du lien.
 */
const FAMILY_BUDGETS: ReadonlyArray<{ path: RegExp; timeoutMs: number }> = [
  { path: /^\/hermes-setup\/toolsets\//, timeoutMs: TOOLSET_MUTATION_TIMEOUT_MS },
  { path: /^\/hermes-setup\/profiles\/[^/]+\/skills\/hub\/install$/, timeoutMs: SKILLS_HUB_INSTALL_TIMEOUT_MS },
  { path: /^\/hermes-setup\/profiles(?:\/|$)/, timeoutMs: PROFILE_MUTATION_TIMEOUT_MS },
  { path: /^\/hermes-setup\/mcp\/catalog\//, timeoutMs: MCP_INSTALL_TIMEOUT_MS },
  { path: /^\/hermes-setup\/mcp\//, timeoutMs: MCP_MUTATION_TIMEOUT_MS },
];

const PROFILE_PREFIX = /^\/p\/[a-z0-9][a-z0-9_-]{0,62}/;

/** Le délai de première réponse d'une requête : jamais sous `defaultMs`, prolongé pour une mutation hôte longue. */
export function firstResponseBudgetMs(method: string, path: string, defaultMs: number): number {
  if (method.toUpperCase() === "GET") return defaultMs;
  const bare = (path.split("?")[0] ?? "").replace(PROFILE_PREFIX, "");
  const family = FAMILY_BUDGETS.find((entry) => entry.path.test(bare));
  return family ? Math.max(defaultMs, family.timeoutMs) : defaultMs;
}
