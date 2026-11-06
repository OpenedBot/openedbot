import type { HermesClient } from "@openedbot/hermes";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";

export type RuntimeReader = typeof readRuntimeSecret;
export type InventoryClient = Pick<
  HermesClient,
  | "capabilityInventory"
  | "connectorManagementProbe"
  | "hostCapabilities"
  | "hostToolsets"
  | "hostSkills"
  | "hostProfileInventory"
  | "hostDeleteProfile"
  | "deleteSession"
  | "toolsetSet"
  | "mcpInventory"
  | "mcpServerAdd"
  | "mcpCatalogInstall"
  | "mcpServerRemove"
  | "hostRemoveProfileMcpServer"
  | "mcpOauthStart"
  | "mcpOauthPoll"
  | "mcpOauthCallback"
  | "mcpOauthCancel"
  | "gatewayStatus"
  | "gatewayRestart"
  | "gatewayRestartPoll"
>;

export const DEFAULT_INVENTORY_TIMEOUT_MS = 9_000;
/**
 * L'inventaire MCP a sa propre échéance, plus large que les lectures gateway,
 * et sa propre ROUTE.
 *
 * Il fait démarrer un interpréteur Python froid sur l'hôte, là où les autres
 * lectures touchent un serveur déjà chaud. Le borner comme elles ferait dire
 * « MCP indisponible » à un hôte parfaitement sain sur une petite machine ;
 * l'attendre dans la charge de la page ferait payer cette lenteur à un écran
 * qui n'en a pas besoin pour s'afficher. Il est donc lu à part, quand le
 * panneau qui l'utilise s'ouvre.
 */
export const MCP_INVENTORY_TIMEOUT_MS = 25_000;
export const TOOLSET_NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_MCP_TOKEN = 4_000;
export const MAX_MCP_URL = 2_048;

export const PROFILE_INVENTORY_TIMEOUT_MS = 60_000;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
export const MAX_OAUTH_CALLBACK = 4_096;
