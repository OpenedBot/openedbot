import { Hono } from "hono";
import type { AppVariables } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { integrationRouteContext, type IntegrationRouteDependencies } from "./runtime-integration-context";
import { runtimeProfileRoutes } from "./runtime-integration-profile-routes";
import { runtimeInventoryRoutes } from "./runtime-integration-inventory-routes";
import { runtimeMcpRoutes } from "./runtime-integration-mcp-routes";
import { runtimeMcpOauthRoutes } from "./runtime-integration-oauth-routes";
import { runtimeGatewayRoutes } from "./runtime-integration-gateway-routes";

export { mcpOauthCallbackRoutes } from "./runtime-integration-oauth-routes";
export { publicEndpoint, publicWriteError, runtimeIntegrationInventory } from "./runtime-integration-public";

/**
 * Global inventory of the runtime and administration of its capability surface.
 *
 * The route is reserved to owners and administrators: it reveals the
 * organization's tool topology.
 *
 * Always true: the API opens NO shell session toward a customer's
 * machine and holds no key that would open one. The writes in this
 * file all go through the same already-authenticated HTTPS channel as the
 * runs, up to the host's `edge-setup` operator, and are limited to named
 * verbs: enable a toolset, add or remove an MCP server,
 * install an entry from the approved catalog, authorize an OAuth MCP server,
 * restart the gateway, delete a profile from the host. No command,
 * no path, no exec/update verb passes through. The restart is the ONLY one the link carries:
 * fixed route, fixed unit on the host, no argument, proven on `/health`.
 *
 * A host that does not advertise the matching capability does not receive
 * the write: the page stays read-only, and says so.
 */
export function runtimeIntegrationRoutes(
  db: Db,
  config: ApiConfig,
  dependencies: IntegrationRouteDependencies = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const ctx = integrationRouteContext(db, config, dependencies);
  routes.route("/", runtimeProfileRoutes(ctx));
  routes.route("/", runtimeInventoryRoutes(ctx));
  routes.route("/", runtimeMcpRoutes(ctx));
  routes.route("/", runtimeMcpOauthRoutes(ctx));
  routes.route("/", runtimeGatewayRoutes(ctx));
  return routes;
}
