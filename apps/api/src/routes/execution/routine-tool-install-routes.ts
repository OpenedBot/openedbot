import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { HermesClient, type HermesClientConfig } from "@openedbot/hermes";
import type { BotRoutineToolDto } from "@openedbot/contracts-api";
import { ROUTINE_TOOL_NAME, ROUTINE_TOOL_SERVER } from "@openedbot/execution/domain/routine-tool";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { publicWriteError } from "../runtimes/runtime-integration-routes";
import { routineToolSecretHash } from "./routine-tool-routes";

/**
 * Activer `routine_manage` pour un bot (DEV-209), depuis son panneau Routines.
 *
 * Tout passe par les verbes nommés que l'hôte annonce déjà, jamais par un
 * shell : `mcp_management` ajoute à la racine le serveur `ohb_routines` (https
 * vers CETTE API, bearer propre au runtime), `profile_capabilities` l'active
 * sur le profil du bot. L'écriture est prouvée par relecture de l'inventaire
 * MCP de l'hôte, jamais par un code de sortie (règle 2 de la frontière).
 *
 * Le secret du bearer n'existe qu'en transit vers l'hôte : la base n'en garde
 * que l'empreinte, et le réactiver après une perte de l'entrée sur l'hôte en
 * pose un nouveau. Le gateway ne lit ses serveurs MCP qu'au démarrage : la
 * réponse dit `restartPending`, et la console offre le redémarrage nommé.
 */
const FEATURE_MCP = "mcp_management";
const FEATURE_PROFILE_CAPABILITIES = "profile_capabilities";

type InstallClient = Pick<
  HermesClient,
  "hostCapabilities" | "mcpInventory" | "mcpServerAdd" | "mcpServerRemove" | "hostSetProfileMcpServer" | "gatewayStatus"
>;

export type RoutineToolInstallDeps = {
  readRuntime?: typeof readRuntimeSecret;
  clientFactory?: (clientConfig: HermesClientConfig) => InstallClient;
};

type BotTarget = { id: string; profile: string | null };
type ToolRow = { runtimeId: string; installedAt: Date | string | null; enabledBotIds: string[] };

export function botRoutineToolRoutes(
  db: Db,
  config: ApiConfig,
  deps: RoutineToolInstallDeps = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const readRuntime = deps.readRuntime ?? readRuntimeSecret;
  const clientFactory = deps.clientFactory ?? ((clientConfig: HermesClientConfig) => new HermesClient(clientConfig));

  const readBot = async (organizationId: string, botId: string): Promise<BotTarget> => {
    const rows = await withTenant(db, organizationId, (tx) => tx<BotTarget[]>`
      select id, hermes_profile as profile from bots where organization_id = ${organizationId} and id = ${botId}
    `);
    if (!rows[0]) throw new HttpError(404, "BOT_NOT_FOUND", "Bot introuvable.");
    return rows[0];
  };

  const readToolRow = async (organizationId: string): Promise<ToolRow | null> => {
    const rows = await withTenant(db, organizationId, (tx) => tx<ToolRow[]>`
      select runtime_id as "runtimeId", installed_at as "installedAt", enabled_bot_ids::text[] as "enabledBotIds"
        from runtime_routine_tools where organization_id = ${organizationId}
    `);
    return rows[0] ?? null;
  };

  /** Le client de l'hôte et ce qu'il sait faire pour CE bot, sans rien écrire. */
  const hostFor = async (organizationId: string, bot: BotTarget) => {
    // L'hôte appelle CETTE API : il refuse un serveur MCP qui n'est pas en
    // https, et une API locale n'est de toute façon pas joignable depuis lui.
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
    if (!features?.includes(FEATURE_MCP)) return { runtime, client, reason: "host_unsupported" as const };
    if (bot.profile && !features.includes(FEATURE_PROFILE_CAPABILITIES)) {
      return { runtime, client, reason: "profile_unsupported" as const };
    }
    return { runtime, client, reason: null };
  };

  routes.get("/:botId/routine-tool", async (context) => {
    const auth = context.get("auth");
    const bot = await readBot(auth.organizationId, context.req.param("botId"));
    const row = await readToolRow(auth.organizationId);
    const enabled = Boolean(row?.installedAt) && (row?.enabledBotIds ?? []).includes(bot.id);
    const host = await hostFor(auth.organizationId, bot);
    return context.json<BotRoutineToolDto>({
      available: host.reason === null,
      reason: host.reason,
      enabled,
      restartPending: false,
    });
  });

  routes.put("/:botId/routine-tool", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "BODY_INVALID", "enabled doit être un booléen.");
    const bot = await readBot(auth.organizationId, context.req.param("botId"));
    const host = await hostFor(auth.organizationId, bot);
    if (host.reason !== null || !host.client || !host.runtime) {
      throw new HttpError(409, "ROUTINE_TOOL_UNAVAILABLE", "L’hôte de ce runtime ne sait pas installer cet outil. Mettez `edge-setup` à jour.");
    }
    const { client, runtime } = host;

    try {
      if (body.enabled) {
        await ensureServer(client, runtime.id, auth.organizationId, auth.userId);
        if (bot.profile) {
          const state = await client.hostSetProfileMcpServer(bot.profile, ROUTINE_TOOL_SERVER, true);
          if (!state.applied) {
            throw new HttpError(502, "ROUTINE_TOOL_UNVERIFIED", "L’hôte n’a pas confirmé l’outil sur le profil du bot.");
          }
        }
        await withTenant(db, auth.organizationId, (tx) => tx`
          update runtime_routine_tools
             set enabled_bot_ids = array(select distinct unnest(enabled_bot_ids || array[${bot.id}::uuid])),
                 updated_at = now()
           where organization_id = ${auth.organizationId}
        `);
      } else {
        if (bot.profile) {
          const inventory = await client.mcpInventory();
          if (inventory.servers.some((server) => server.name === ROUTINE_TOOL_SERVER)) {
            await client.hostSetProfileMcpServer(bot.profile, ROUTINE_TOOL_SERVER, false);
          }
        }
        await withTenant(db, auth.organizationId, (tx) => tx`
          update runtime_routine_tools
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
      // Lecture d'agrément : la bascule est déjà prouvée par l'inventaire.
    }
    const row = await readToolRow(auth.organizationId);
    return context.json<BotRoutineToolDto>({
      available: true,
      reason: null,
      enabled: Boolean(row?.installedAt) && (row?.enabledBotIds ?? []).includes(bot.id),
      restartPending,
    });
  });

  /**
   * Le serveur racine, posé une fois par runtime. Relu sur l'hôte à chaque
   * activation : une entrée retirée à la main depuis la console de l'hôte est
   * reposée avec un NOUVEAU secret, l'ancien n'étant connu de personne.
   */
  async function ensureServer(client: InstallClient, runtimeId: string, organizationId: string, userId: string): Promise<void> {
    const row = await readToolRow(organizationId);
    const inventory = await client.mcpInventory();
    const present = inventory.servers.find((server) => server.name === ROUTINE_TOOL_SERVER);
    if (row?.installedAt && row.runtimeId === runtimeId && present?.configEnabled) return;

    const secret = randomBytes(32).toString("base64url");
    await withTenant(db, organizationId, (tx) => tx`
      insert into runtime_routine_tools (organization_id, runtime_id, secret_hash, server_name, created_by_user_id)
      values (${organizationId}, ${runtimeId}, ${routineToolSecretHash(secret)}, ${ROUTINE_TOOL_SERVER}, ${userId})
      on conflict (organization_id, runtime_id) do update
        set secret_hash = excluded.secret_hash, installed_at = null, updated_at = now()
    `);
    const added = await client.mcpServerAdd({
      name: ROUTINE_TOOL_SERVER,
      url: `${config.publicUrl.replace(/\/+$/, "")}/api/mcp/routines/${organizationId}`,
      auth: "header",
      token: secret,
      replace: true,
    });
    // L'hôte sonde le serveur à l'ajout : s'il n'a pas pu joindre l'API, il
    // l'enregistre désactivé, et aucun run ne verrait l'outil.
    if (added.unreachable || !added.discoveredTools?.includes(ROUTINE_TOOL_NAME)) {
      throw new HttpError(
        502,
        "ROUTINE_TOOL_UNREACHABLE",
        "L’hôte n’a pas pu joindre le serveur de routines d’openedbot. Vérifiez que l’API est publique en https.",
      );
    }
    const reread = await client.mcpInventory();
    if (!reread.servers.some((server) => server.name === ROUTINE_TOOL_SERVER && server.configEnabled)) {
      throw new HttpError(502, "ROUTINE_TOOL_UNVERIFIED", "L’hôte n’a pas confirmé le serveur de routines.");
    }
    await withTenant(db, organizationId, (tx) => tx`
      update runtime_routine_tools set installed_at = now(), updated_at = now()
       where organization_id = ${organizationId} and runtime_id = ${runtimeId}
    `);
  }

  return routes;
}
