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
 * Inventaire global du runtime et administration de sa surface de capacités.
 *
 * La route est réservée aux propriétaires et administrateurs : elle révèle la
 * topologie d'outils de l'organisation.
 *
 * Toujours vrai : l'API n'ouvre AUCUNE session shell vers la machine d'un
 * client et ne détient aucune clé qui en ouvrirait une. Les écritures de ce
 * fichier passent toutes par le même canal HTTPS déjà authentifié que les
 * runs, jusqu'à l'opérateur `edge-setup` de l'hôte, et se limitent à des
 * verbes nommés : activer un toolset, ajouter ou retirer un serveur MCP,
 * installer une entrée du catalogue approuvé, autoriser un serveur MCP OAuth,
 * redémarrer le gateway, supprimer un profil de l'hôte. Aucune commande,
 * aucun chemin, aucun verbe exec/update ne transite. Le redémarrage est le SEUL que le lien porte :
 * route fixe, unité fixe sur l'hôte, aucun argument, prouvé sur `/health`.
 *
 * Un hôte qui n'annonce pas la capacité correspondante ne reçoit pas
 * l'écriture : la page reste en lecture seule, et le dit.
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
