import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { HermesClient, HermesClientConfig } from "@openedbot/hermes";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import type { BotSettingsToolDto } from "@openedbot/contracts-api";
import { BOT_SETTINGS_TOOL_NAME, BOT_SETTINGS_TOOL_SERVER } from "@openedbot/execution/domain/bot-settings-tool";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { publicWriteError } from "../runtimes/runtime-integration-routes";
import { botSettingsToolSecretHash } from "./bot-settings-tool-routes";
import { RELAY_FEATURE_MCP_MANAGEMENT, RELAY_FEATURE_PROFILE_CAPABILITIES } from "@openedbot/contracts-connector/features";

type InstallClient = Pick<
  HermesClient,
  "hostCapabilities" | "mcpInventory" | "mcpServerAdd" | "hostSetProfileMcpServer" | "gatewayStatus"
>;
export type BotSettingsToolInstallDeps = {
  readRuntime?: typeof readRuntimeSecret;
  clientFactory?: (clientConfig: HermesClientConfig) => InstallClient;
};
type BotTarget = { id: string; profile: string | null };
type ToolRow = { runtimeId: string; installedAt: Date | string | null; enabledBotIds: string[] };

export function botSettingsToolRoutes(
  db: Db,
  config: ApiConfig,
  deps: BotSettingsToolInstallDeps = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const readRuntime = deps.readRuntime ?? readRuntimeSecret;
  const clientFactory = deps.clientFactory ?? runtimeAdminClient;

  const readBot = async (organizationId: string, botId: string): Promise<BotTarget> => {
    const rows = await withTenant(db, organizationId, (tx) => tx<BotTarget[]>`
      select id, hermes_profile as profile from bots where organization_id = ${organizationId} and id = ${botId}
    `);
    if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot not found.");
    return rows[0];
  };

  const readToolRow = async (organizationId: string): Promise<ToolRow | null> => {
    const rows = await withTenant(db, organizationId, (tx) => tx<ToolRow[]>`
      select runtime_id as "runtimeId", installed_at as "installedAt", enabled_bot_ids::text[] as "enabledBotIds"
        from runtime_bot_settings_tools where organization_id = ${organizationId}
    `);
    return rows[0] ?? null;
  };

  const hostFor = async (organizationId: string, bot: BotTarget) => {
    if (!config.publicUrl.startsWith("https://")) return { runtime: null, client: null, reason: "https_required" as const };
    const runtime = await readRuntime(db, config, organizationId);
    if (!runtime) return { runtime: null, client: null, reason: "runtime_required" as const };
    const client = clientFactory(runtime.client);
    let features: string[] | null;
    try {
      features = await client.hostCapabilities();
    } catch (error) {
      throw publicWriteError(error);
    }
    if (!features?.includes(RELAY_FEATURE_MCP_MANAGEMENT)) return { runtime, client, reason: "host_unsupported" as const };
    if (bot.profile && !features.includes(RELAY_FEATURE_PROFILE_CAPABILITIES)) {
      return { runtime, client, reason: "profile_unsupported" as const };
    }
    return { runtime, client, reason: null };
  };

  routes.get("/:botId/settings-tool", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const bot = await readBot(auth.organizationId, context.req.param("botId"));
    const row = await readToolRow(auth.organizationId);
    const enabled = Boolean(row?.installedAt) && (row?.enabledBotIds ?? []).includes(bot.id);
    const host = await hostFor(auth.organizationId, bot);
    return context.json<BotSettingsToolDto>({
      available: host.reason === null,
      reason: host.reason,
      enabled,
      restartPending: false,
    });
  });

  routes.put("/:botId/settings-tool", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "BODY_INVALID", "enabled must be a boolean.");
    const bot = await readBot(auth.organizationId, context.req.param("botId"));
    const host = await hostFor(auth.organizationId, bot);
    if (host.reason !== null || !host.client || !host.runtime) {
      throw new HttpError(409, "BOT_SETTINGS_TOOL_UNAVAILABLE", "This runtime host cannot install the bot settings tool.");
    }
    const { client, runtime } = host;

    try {
      if (body.enabled) {
        await ensureServer(client, runtime.id, auth.organizationId, auth.userId);
        if (bot.profile) {
          const state = await client.hostSetProfileMcpServer(bot.profile, BOT_SETTINGS_TOOL_SERVER, true);
          if (!state.applied) {
            throw new HttpError(502, "BOT_SETTINGS_TOOL_UNVERIFIED", "The host did not confirm the tool on this bot profile.");
          }
        }
        await withTenant(db, auth.organizationId, (tx) => tx`
          update runtime_bot_settings_tools
             set enabled_bot_ids = array(select distinct unnest(enabled_bot_ids || array[${bot.id}::uuid])),
                 updated_at = now()
           where organization_id = ${auth.organizationId}
        `);
      } else {
        if (bot.profile) {
          const inventory = await client.mcpInventory();
          if (inventory.servers.some((server) => server.name === BOT_SETTINGS_TOOL_SERVER)) {
            await client.hostSetProfileMcpServer(bot.profile, BOT_SETTINGS_TOOL_SERVER, false);
          }
        }
        await withTenant(db, auth.organizationId, (tx) => tx`
          update runtime_bot_settings_tools
             set enabled_bot_ids = array_remove(enabled_bot_ids, ${bot.id}::uuid), updated_at = now()
           where organization_id = ${auth.organizationId}
        `);
      }
    } catch (error) {
      throw publicWriteError(error);
    }

    let restartPending = false;
    try {
      restartPending = (await client.gatewayStatus()).restartPending;
    } catch {
      // The switch is already proven by the MCP inventory.
    }
    const row = await readToolRow(auth.organizationId);
    return context.json<BotSettingsToolDto>({
      available: true,
      reason: null,
      enabled: Boolean(row?.installedAt) && (row?.enabledBotIds ?? []).includes(bot.id),
      restartPending,
    });
  });

  async function ensureServer(client: InstallClient, runtimeId: string, organizationId: string, userId: string): Promise<void> {
    const row = await readToolRow(organizationId);
    const inventory = await client.mcpInventory();
    const present = inventory.servers.find((server) => server.name === BOT_SETTINGS_TOOL_SERVER);
    if (row?.installedAt && row.runtimeId === runtimeId && present?.configEnabled) return;

    const secret = randomBytes(32).toString("base64url");
    await withTenant(db, organizationId, (tx) => tx`
      insert into runtime_bot_settings_tools (organization_id, runtime_id, secret_hash, server_name, created_by_user_id)
      values (${organizationId}, ${runtimeId}, ${botSettingsToolSecretHash(secret)}, ${BOT_SETTINGS_TOOL_SERVER}, ${userId})
      on conflict (organization_id, runtime_id) do update
        set secret_hash = excluded.secret_hash, installed_at = null, updated_at = now()
    `);
    const added = await client.mcpServerAdd({
      name: BOT_SETTINGS_TOOL_SERVER,
      url: `${config.publicUrl.replace(/\/+$/, "")}/api/mcp/bot-settings/${organizationId}`,
      auth: "header",
      token: secret,
      replace: true,
    });
    if (added.unreachable || !added.discoveredTools?.includes(BOT_SETTINGS_TOOL_NAME)) {
      throw new HttpError(
        502,
        "BOT_SETTINGS_TOOL_UNREACHABLE",
        "The runtime host could not reach the openedbot bot settings tool. Check that the public API uses https.",
      );
    }
    const reread = await client.mcpInventory();
    if (!reread.servers.some((server) => server.name === BOT_SETTINGS_TOOL_SERVER && server.configEnabled)) {
      throw new HttpError(502, "BOT_SETTINGS_TOOL_UNVERIFIED", "The host did not confirm the bot settings server.");
    }
    await withTenant(db, organizationId, (tx) => tx`
      update runtime_bot_settings_tools set installed_at = now(), updated_at = now()
       where organization_id = ${organizationId} and runtime_id = ${runtimeId}
    `);
  }

  return routes;
}
