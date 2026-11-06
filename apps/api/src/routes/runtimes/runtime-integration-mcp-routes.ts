import { isUuid } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { HermesClientError, type HermesClientConfig, type HermesMcpOauthSession, type HermesMcpServer } from "@openedbot/hermes";
import {
  mcpCatalogRootMatch,
  mcpConnectorEntry,
} from "@openedbot/runtimes/domain/mcp-connector-catalog";
import { readBotCapabilityTarget } from "@openedbot/roster/application/bot-reads";
import type {
  RuntimeIntegrationMcpDto,
  RuntimeIntegrationMcpServerDto,
  RuntimeMcpDisconnectDto,
  RuntimeMcpOauthDto,
} from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import { requestOrigin, requireOperator } from "../identity/auth";
import { withTenant } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { connectorOpenedbotOrigin } from "./runtime-enrollment-routes";
import type { IntegrationRouteContext } from "./runtime-integration-context";
import {
  catalogEnv,
  publicMcp,
  publicMcpOauth,
  publicMcpServer,
  publicWriteError,
  withDeadline,
} from "./runtime-integration-public";
import {
  type InventoryClient,
  MAX_MCP_TOKEN,
  MAX_MCP_URL,
  MCP_INVENTORY_TIMEOUT_MS,
  MCP_NAME_PATTERN,
} from "./runtime-integration-constants";
import { readThrough, wantsFreshRead, watchedReadPolicy } from "@openedbot/runtimes/application/runtime-read-snapshots";
import { RELAY_FEATURE_GATEWAY_RESTART, RELAY_FEATURE_MCP_MANAGEMENT, RELAY_FEATURE_MCP_OAUTH, RELAY_FEATURE_MCP_OAUTH_PROFILE, RELAY_FEATURE_MCP_PROFILE_DISCONNECT } from "@openedbot/contracts-connector/features";

/**
 * Les serveurs MCP de l’hôte : inventaire, ajout, catalogue approuvé, retrait,
 * et la connexion (ou déconnexion) d’une entrée du catalogue à un bot.
 */
export function runtimeMcpRoutes(ctx: IntegrationRouteContext): Hono<{ Variables: AppVariables }> {
  const {
    db,
    config,
    readRuntime,
    clientFactory,
    timeoutMs,
    snapshots,
    invalidateIntegrationReads,
    announcedFeatures,
    requireWritableRuntime,
    requireWritableRuntimeWithId,
  } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * L'inventaire MCP, séparé de la page.
   *
   * Deux raisons, pas une : il coûte un démarrage d'interpréteur sur l'hôte, et
   * il ne sert qu'au panneau d'administration des connecteurs. Le fondre dans
   * `/integrations` faisait payer cette lenteur à chaque affichage de l'écran,
   * y compris à qui ne l'ouvre jamais.
   */
  routes.get("/integrations/mcp", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtime = await readRuntime(db, config, auth.organizationId);
    if (!runtime) return context.json<RuntimeIntegrationMcpDto>(MCP_UNAVAILABLE);
    const dto = await readThrough(snapshots, {
      organizationId: auth.organizationId, runtimeId: runtime.id, kind: "mcp",
      fresh: wantsFreshRead(context.req.query("fresh")),
      keep: keepMcp,
      ...watchedReadPolicy(runtime.inventory),
      read: liveMcpRead(ctx, runtime),
    });
    return context.json(dto);
  });

  /**
   * « Connecter » une entrée du catalogue à UN bot, en une requête.
   *
   * Les jetons MCP vivent dans le home de chaque profil Hermes : une
   * autorisation faite à la racine ne servirait pas aux runs du bot. D'où la
   * feature `mcp_oauth_profile` exigée, sans repli racine. L'entrée vient du
   * catalogue d'openedbot, jamais d'une URL envoyée par l'écran.
   *
   * 1. le serveur est ajouté à la racine s'il n'y est pas (`auth: oauth`) ;
   *    un serveur du même nom vers une autre adresse n'est jamais remplacé ;
   * 2. l'autorisation s'ouvre pour le profil du bot ; l'hôte n'inscrit le
   *    serveur dans ce profil qu'une fois le jeton prouvé.
   *
   * Un double clic retrouve l'autorisation en cours (409 de l'hôte rendu
   * comme la session existante). Le suivi, l'annulation et le retour du
   * fournisseur passent par les routes OAuth existantes, par nom de serveur.
   */
  routes.post("/integrations/mcp/connectors/:id/connect", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const entry = mcpConnectorEntry(context.req.param("id"));
    if (!entry) throw new HttpError(404, "CONNECTOR_UNKNOWN", "Ce connecteur n’est pas au catalogue.");
    const body = await jsonBody(context.req.raw);
    const botId = typeof body.botId === "string" ? body.botId : "";
    if (!isUuid(botId)) throw new HttpError(400, "BOT_INVALID", "Le bot à connecter est manquant.");
    const target = await withTenant(db, auth.organizationId, (tx) => readBotCapabilityTarget(tx, auth.organizationId, botId));
    if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    if (!target.profile) {
      throw new HttpError(409, "BOT_PROFILE_REQUIRED", "Ce bot n’a pas de profil Hermes : créez-le avant de connecter un serveur MCP.");
    }
    const { client, runtimeId } = await requireWritableRuntimeWithId(auth.organizationId, RELAY_FEATURE_MCP_OAUTH_PROFILE);
    const origin = connectorOpenedbotOrigin(config, requestOrigin(context) ?? undefined);
    const redirectUri = `${origin}/api/mcp-oauth/callback/${encodeURIComponent(auth.organizationId)}/${encodeURIComponent(runtimeId)}/${encodeURIComponent(entry.id)}`;
    const rootServer = async () => {
      const inventory = await withDeadline(client.mcpInventory(), MCP_INVENTORY_TIMEOUT_MS);
      return inventory.servers.find((server) => server.name === entry.id) ?? null;
    };
    const refuseConflict = () => new HttpError(
      409,
      "MCP_SERVER_NAME_TAKEN",
      `Un serveur MCP nommé « ${entry.id} » existe déjà sur l’hôte avec une autre adresse ou une autre authentification. `
      + "Retirez-le ou renommez-le depuis Réglages › Connecteurs avant de connecter celui du catalogue.",
    );
    let session: HermesMcpOauthSession;
    try {
      const existing = await rootServer();
      if (existing && mcpCatalogRootMatch(entry, existing) === "conflict") throw refuseConflict();
      if (!existing) {
        try {
          await client.mcpServerAdd({ name: entry.id, url: entry.url, auth: "oauth" });
        } catch (error) {
          // Deux clics, ou deux onglets : l'autre ajout a gagné. Ce n'est un
          // succès que si c'est bien le serveur du catalogue.
          if (!(error instanceof HermesClientError && error.code === "SERVER_EXISTS")) throw error;
          const raced = await rootServer();
          if (!raced || mcpCatalogRootMatch(entry, raced) === "conflict") throw refuseConflict();
        }
      }
      session = await client.mcpOauthStart(entry.id, redirectUri, target.profile);
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
    return context.json<RuntimeMcpOauthDto>(publicMcpOauth(session));
  });

  /**
   * Déconnecte une entrée du catalogue d'UN bot : l'hôte retire le serveur de
   * la configuration du profil et efface ses jetons. Le serveur de la racine,
   * qui sert de modèle aux autres bots, n'est pas touché. Idempotent : un bot
   * déjà déconnecté répond `removed: false`.
   */
  routes.delete("/integrations/mcp/connectors/:id/connections/:botId", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const entry = mcpConnectorEntry(context.req.param("id"));
    if (!entry) throw new HttpError(404, "CONNECTOR_UNKNOWN", "Ce connecteur n’est pas au catalogue.");
    const botId = context.req.param("botId");
    if (!isUuid(botId)) throw new HttpError(400, "BOT_INVALID", "Le bot à déconnecter est manquant.");
    const target = await withTenant(db, auth.organizationId, (tx) => readBotCapabilityTarget(tx, auth.organizationId, botId));
    if (!target) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    if (!target.profile) {
      throw new HttpError(409, "BOT_PROFILE_REQUIRED", "Ce bot n’a pas de profil Hermes : aucun serveur MCP ne lui est connecté.");
    }
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_MCP_PROFILE_DISCONNECT);
    let removal: Awaited<ReturnType<InventoryClient["hostRemoveProfileMcpServer"]>>;
    try {
      removal = await client.hostRemoveProfileMcpServer(target.profile, entry.id);
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
    return context.json<RuntimeMcpDisconnectDto>({
      connector: entry.id,
      botId,
      removed: removal.removed,
      tokensRemoved: removal.tokensRemoved,
    });
  });

  routes.post("/integrations/mcp/servers", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const authMode = body.auth === undefined ? "none" : body.auth;
    const token = typeof body.token === "string" ? body.token : "";
    if (!MCP_NAME_PATTERN.test(name)) {
      throw new HttpError(400, "NAME_INVALID", "Le nom du serveur doit faire 1 à 64 caractères parmi [A-Za-z0-9_-].");
    }
    if (!url.startsWith("https://") || url.length > MAX_MCP_URL) {
      throw new HttpError(400, "URL_INVALID", "L’adresse du serveur MCP doit être une URL https.");
    }
    if (authMode !== "none" && authMode !== "header" && authMode !== "oauth") {
      throw new HttpError(400, "AUTH_INVALID", "L’authentification doit être `none`, `header` ou `oauth`.");
    }
    if (authMode === "header" && (!token || token.length > MAX_MCP_TOKEN)) {
      throw new HttpError(400, "TOKEN_INVALID", "Un jeton porteur est requis pour l’authentification par en-tête.");
    }
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_MCP_MANAGEMENT);
    let server: HermesMcpServer;
    try {
      server = await client.mcpServerAdd({
        name,
        url,
        auth: authMode,
        ...(authMode === "header" ? { token } : {}),
        ...(body.replace === true ? { replace: true } : {}),
      });
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
    return context.json<RuntimeIntegrationMcpServerDto>(publicMcpServer(server));
  });

  routes.post("/integrations/mcp/catalog/:name", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = context.req.param("name");
    if (!MCP_NAME_PATTERN.test(name)) {
      throw new HttpError(400, "NAME_INVALID", "Ce nom d’entrée de catalogue n’est pas valide.");
    }
    const body = await jsonBody(context.req.raw);
    const env = catalogEnv(body.env);
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_MCP_MANAGEMENT);
    let server: HermesMcpServer;
    try {
      server = await client.mcpCatalogInstall(name, env);
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
    return context.json<RuntimeIntegrationMcpServerDto>(publicMcpServer(server));
  });

  routes.delete("/integrations/mcp/servers/:name", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = context.req.param("name");
    if (!MCP_NAME_PATTERN.test(name)) {
      throw new HttpError(400, "NAME_INVALID", "Ce nom de serveur n’est pas valide.");
    }
    const client = await requireWritableRuntime(auth.organizationId, RELAY_FEATURE_MCP_MANAGEMENT);
    try {
      await client.mcpServerRemove(name);
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
    return context.body(null, 204);
  });

  return routes;
}

/** Un hôte sans administration MCP, ou sans runtime : rien à montrer, et rien d'erroné. */
const MCP_UNAVAILABLE: RuntimeIntegrationMcpDto = {
  available: false,
  capabilities: { oauth: false, gatewayRestart: false },
  servers: [],
  catalog: [],
  error: null,
};

/** Ce que garde l'instantané : un inventaire MCP disponible et lu sans erreur. */
export const keepMcp = (value: RuntimeIntegrationMcpDto) => value.available && value.error === null;

/**
 * La lecture vivante de l'inventaire MCP (un interpréteur sur l'hôte). La route
 * la sert à travers l'instantané ; le réchauffage la rejoue sur signal de l'hôte.
 */
export function liveMcpRead(
  ctx: IntegrationRouteContext,
  runtime: { client: HermesClientConfig; linkFeatures?: string[] },
): () => Promise<RuntimeIntegrationMcpDto> {
  const { clientFactory, timeoutMs, announcedFeatures } = ctx;
  return async () => {
    const client = clientFactory(runtime.client);
    let hostFeatures: string[] | null = null;
    try { hostFeatures = await withDeadline(announcedFeatures(runtime, client), timeoutMs); } catch { hostFeatures = null; }
    if (!hostFeatures?.includes(RELAY_FEATURE_MCP_MANAGEMENT)) return MCP_UNAVAILABLE;
    const result = await Promise.allSettled([withDeadline(client.mcpInventory(), MCP_INVENTORY_TIMEOUT_MS)]).then(([entry]) => entry!);
    return publicMcp(
      { oauth: hostFeatures.includes(RELAY_FEATURE_MCP_OAUTH), gatewayRestart: hostFeatures.includes(RELAY_FEATURE_GATEWAY_RESTART) },
      result.status === "fulfilled" ? result.value : null,
      result.status === "rejected" ? result.reason : null,
    );
  };
}
