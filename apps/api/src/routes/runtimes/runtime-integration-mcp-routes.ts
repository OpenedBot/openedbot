import { isReservedMcpServerName } from "@openedbot/execution/domain/routine-tool-names";
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
import { startMcpOauth } from "./runtime-integration-oauth-routes";
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
  PROFILE_INVENTORY_TIMEOUT_MS,
  MCP_NAME_PATTERN,
} from "./runtime-integration-constants";
import { readThrough, wantsFreshRead, watchedReadPolicy } from "@openedbot/runtimes/application/runtime-read-snapshots";
import { RELAY_FEATURE_GATEWAY_RESTART, RELAY_FEATURE_MCP_MANAGEMENT, RELAY_FEATURE_MCP_OAUTH, RELAY_FEATURE_MCP_OAUTH_PROFILE, RELAY_FEATURE_MCP_PROFILE_DISCONNECT, RELAY_FEATURE_PROFILE_INVENTORY } from "@openedbot/contracts-connector/features";

/**
 * The host's MCP servers: inventory, add, approved catalog, removal,
 * and connecting (or disconnecting) a catalog entry to a bot.
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
   * The MCP inventory, separate from the page.
   *
   * Two reasons, not one: it costs an interpreter startup on the host, and
   * it serves only the connector administration panel. Folding it into
   * `/integrations` made every display of the screen pay for that slowness,
   * including for whoever never opens it.
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
   * « Connecter » a catalog entry to ONE bot, in one request.
   *
   * MCP tokens live in each Hermes profile's home: an
   * authorization done at the root would not serve the bot's runs. Hence the
   * required `mcp_oauth_profile` feature, with no root fallback. The entry comes from
   * openedbot's catalog, never from a URL sent by the screen.
   *
   * 1. the server is added at the root if it is not there (`auth: oauth`);
   *    a server of the same name toward another address is never replaced;
   * 2. authorization opens for the bot's profile; the host records the
   *    server in that profile only once the token is proven.
   *
   * A double click finds the authorization in progress of the SAME profile
   * and resumes it; one in progress for another bot (or that an older host
   * does not attribute) is a 409 `MCP_OAUTH_IN_PROGRESS`, never returned as
   * this bot's, until the operator asks to replace it (`replacePending`).
   * Follow-up, cancellation and the provider's return go through the
   * existing OAuth routes, by server name.
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
    const { client, runtimeId, features } = await requireWritableRuntimeWithId(auth.organizationId, RELAY_FEATURE_MCP_OAUTH_PROFILE);
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
    // The host authorizes the PROFILE's entry when the profile carries one
    // (the root is only the template for a profile without it): a same-named
    // entry toward another address would be authorized, and announced, as
    // the catalog's. Known only from a host that describes profile entries
    // (`auth`); an older host is not refused, as before.
    const profileConflict = async () => {
      if (!features.includes(RELAY_FEATURE_PROFILE_INVENTORY)) return false;
      const inventory = await withDeadline(client.hostProfileInventory(), PROFILE_INVENTORY_TIMEOUT_MS);
      const server = inventory.profiles.find((profile) => profile.name === target.profile)
        ?.mcpServers.find((candidate) => candidate.name === entry.id);
      if (!server || server.auth === undefined) return false;
      return mcpCatalogRootMatch(entry, { endpoint: server.endpoint ?? null, auth: server.auth }) === "conflict";
    };
    let session: HermesMcpOauthSession;
    try {
      if (await profileConflict()) {
        throw new HttpError(
          409,
          "MCP_SERVER_NAME_TAKEN",
          `Le profil de ce bot porte déjà un serveur MCP nommé « ${entry.id} » vers une autre adresse ou avec une autre authentification. `
          + "Renommez-le ou retirez-le du profil de ce bot sur l’hôte avant de connecter celui du catalogue.",
        );
      }
      const existing = await rootServer();
      if (existing && mcpCatalogRootMatch(entry, existing) === "conflict") throw refuseConflict();
      if (!existing) {
        try {
          await client.mcpServerAdd({ name: entry.id, url: entry.url, auth: "oauth" });
        } catch (error) {
          // Two clicks, or two tabs: the other add won. It is a
          // success only if it really is the catalog's server.
          if (!(error instanceof HermesClientError && error.code === "SERVER_EXISTS")) throw error;
          const raced = await rootServer();
          if (!raced || mcpCatalogRootMatch(entry, raced) === "conflict") throw refuseConflict();
        }
      }
      session = await startMcpOauth(client, {
        server: entry.id,
        redirectUri,
        profile: target.profile,
        replacePending: body.replacePending === true,
      });
    } catch (error) {
      throw publicWriteError(error);
    } finally {
      await invalidateIntegrationReads(auth.organizationId);
    }
    return context.json<RuntimeMcpOauthDto>(publicMcpOauth(session));
  });

  /**
   * Disconnects a catalog entry from ONE bot: the host removes the server from
   * the profile's configuration and erases its tokens. The root server,
   * which serves as the model for the other bots, is not touched. Idempotent: a bot
   * already disconnected answers `removed: false`.
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
    // `openedbot_routines` and `openedbot_bot_settings` are installed by openedbot
    // itself: a server added under such a name would receive their run keys.
    if (isReservedMcpServerName(name)) {
      throw new HttpError(400, "NAME_RESERVED", "Les noms commençant par « openedbot_ » sont réservés aux outils d’openedbot.");
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

/** A host without MCP administration, or without a runtime: nothing to show, and nothing wrong. */
const MCP_UNAVAILABLE: RuntimeIntegrationMcpDto = {
  available: false,
  capabilities: { oauth: false, gatewayRestart: false },
  servers: [],
  catalog: [],
  error: null,
};

/** What the snapshot keeps: an MCP inventory that is available and read without error. */
export const keepMcp = (value: RuntimeIntegrationMcpDto) => value.available && value.error === null;

/**
 * The live read of the MCP inventory (an interpreter on the host). The route
 * serves it through the snapshot; the warm-up replays it on a signal from the host.
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
