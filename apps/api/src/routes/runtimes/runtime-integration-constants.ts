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
 * The MCP inventory has its own deadline, wider than the gateway reads,
 * and its own ROUTE.
 *
 * It starts a cold Python interpreter on the host, where the other
 * reads touch an already warm server. Bounding it like them would make
 * a perfectly healthy host on a small machine say
 * « MCP indisponible »; waiting for it in the page load would charge that slowness to a screen
 * that does not need it in order to render. It is therefore read apart, when the
 * panel that uses it opens.
 */
export const MCP_INVENTORY_TIMEOUT_MS = 25_000;
export const TOOLSET_NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_MCP_TOKEN = 4_000;
export const MAX_MCP_URL = 2_048;

export const PROFILE_INVENTORY_TIMEOUT_MS = 60_000;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
export const MAX_OAUTH_CALLBACK = 4_096;
