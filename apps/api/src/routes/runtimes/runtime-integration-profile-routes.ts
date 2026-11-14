import { Hono } from "hono";
import { type HermesClientConfig, type HermesProfileInventory, type HermesProfileMcpServer } from "@openedbot/hermes";
import { OPENEDBOT_SERVICE_PROFILES } from "@openedbot/runtimes/domain/runtime-contract";
import { mcpPublicServerEndpoint } from "@openedbot/runtimes/domain/mcp-connector-catalog";
import type {
  RuntimeHostProfileDto,
  RuntimeProfileDeleteDto,
  RuntimeProfileDeleteJobDto,
  RuntimeProfileDeleteJobListDto,
  RuntimeProfileInventoryDto,
  RuntimeProfileMcpServerDto,
} from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { withTenant } from "@openedbot/platform-db";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import {
  invalidateSnapshots,
  readThrough,
  wantsFreshRead,
} from "@openedbot/runtimes/application/runtime-read-snapshots";
import { asProfileHttpError, withProfileNamesLock } from "@openedbot/roster/application/profile-import-guard";
import { deleteHostProfile, parseDeleteJobSlugs } from "@openedbot/portability/application/host-profile-delete";
import { enqueueProfileDelete, lastProfileJobChange, listDeleteJobs } from "@openedbot/portability/application/delete-jobs";
import type { IntegrationRouteContext } from "./runtime-integration-context";
import { publicWriteError, withDeadline } from "./runtime-integration-public";
import {
  PROFILE_INVENTORY_TIMEOUT_MS,
} from "./runtime-integration-constants";
import { RELAY_FEATURE_PROFILE_INVENTORY, RELAY_FEATURE_PROFILE_MANAGEMENT } from "@openedbot/contracts-connector/features";

/** The host's Hermes profiles: inventory, and deletions in a batch or one by one. */
export function runtimeProfileRoutes(ctx: IntegrationRouteContext): Hono<{ Variables: AppVariables }> {
  const { db, config, readRuntime, clientFactory, snapshots, requireWritableRuntimeWithId } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  /** Public inventory of the Hermes profiles advertised by the host. */
  routes.get("/profiles", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtime = await readRuntime(db, config, auth.organizationId);
    if (!runtime) {
      throw new HttpError(404, "RUNTIME_REQUIRED", "Aucun runtime Hermes actif : il n’y a rien à lire.");
    }
    // The worker settles profile imports and deletions on the host and cannot
    // touch the snapshot table: the last job change dates the host list, and
    // a snapshot older than it is read again.
    const changedAt = await lastProfileJobChange(db, auth.organizationId, runtime.id);
    const hostPart = await readThrough(snapshots, {
      organizationId: auth.organizationId,
      runtimeId: runtime.id,
      kind: "profiles",
      fresh: wantsFreshRead(context.req.query("fresh")),
      notOlderThan: changedAt,
      read: liveProfilesRead(ctx, runtime),
    });
    const features = hostPart.features;
    // alreadyImported: any row with hermes_profile, including archived bots.
    const linked = await withTenant(db, auth.organizationId, async (tx) =>
      tx<Array<{ id: string; hermesProfile: string }>>`
        select id, hermes_profile as "hermesProfile" from bots
         where organization_id = ${auth.organizationId} and hermes_profile is not null
      `,
    );
    const byProfile = new Map(linked.map((row) => [row.hermesProfile, row.id]));
    const profiles: RuntimeHostProfileDto[] = hostPart.profiles.map((profile) => ({
      ...profile,
      // A snapshot written before this field does not carry it.
      mcpServers: profile.mcpServers ?? [],
      alreadyImported: byProfile.has(profile.name),
      importedBotId: byProfile.get(profile.name) ?? null,
    }));
    return context.json<RuntimeProfileInventoryDto>({
      profiles,
      canDelete: Boolean(features?.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)),
    });
  });

  /**
   * Queues a batch of deletions toward the worker. The 202 response returns the job;
   * the client polls GET /profiles/delete-jobs. The table and the tabs stay
   * usable while the host is read and erased, slug by slug.
   */
  routes.post("/profiles/delete-jobs", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    let slugs: string[];
    try {
      slugs = parseDeleteJobSlugs(await jsonBody(context.req.raw));
    } catch (error) {
      const mapped = asProfileHttpError(error);
      throw mapped instanceof HttpError ? mapped : error;
    }
    const { runtimeId } = await requireWritableRuntimeWithId(auth.organizationId, RELAY_FEATURE_PROFILE_MANAGEMENT);
    try {
      const job = await enqueueProfileDelete(db, auth.organizationId, auth.userId, runtimeId, slugs);
      await invalidateSnapshots(snapshots, auth.organizationId, "profiles");
      return context.json<RuntimeProfileDeleteJobDto>(job, 202);
    } catch (error) {
      const mapped = asProfileHttpError(error);
      throw mapped instanceof HttpError ? mapped : error;
    }
  });

  routes.get("/profiles/delete-jobs", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    return context.json<RuntimeProfileDeleteJobListDto>(await listDeleteJobs(db, auth.organizationId));
  });

  /**
   * Deletion of a profile on the host's disk. If a bot (including an
   * archived one) carries this hermes_profile, its runtime sessions go first;
   * a purge failure or a reread that still sees the slug leaves the SQL row.
   */
  routes.delete("/profiles/:slug", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const slug = context.req.param("slug");
    const { client } = await requireWritableRuntimeWithId(auth.organizationId, RELAY_FEATURE_PROFILE_MANAGEMENT);
    const runtime = await readRuntime(db, config, auth.organizationId);
    if (!runtime) {
      throw new HttpError(404, "RUNTIME_REQUIRED", "Aucun runtime Hermes actif : il n’y a rien à configurer.");
    }
    try {
      // The import lock is held for the whole deletion: an import
      // does not reserve this slug between the check and the remote DELETE.
      const result = await withProfileNamesLock(db, auth.organizationId, [slug], (connection) =>
        deleteHostProfile(connection, auth.organizationId, slug, {
          host: client,
          sessionClient: (profile) => clientFactory({ ...runtime.client, profile }),
          timeoutMs: PROFILE_INVENTORY_TIMEOUT_MS,
        }));
      return context.json<RuntimeProfileDeleteDto>(result);
    } catch (error) {
      const mapped = asProfileHttpError(error);
      if (mapped instanceof HttpError) throw mapped;
      throw publicWriteError(error);
    } finally {
      await invalidateSnapshots(snapshots, auth.organizationId, "profiles");
    }
  });

  return routes;
}

/**
 * A profile's MCP server as the snapshot may keep it and the console may see
 * it: name and state, plus the host's facts about the entry when it gave
 * them (all or none, as parsed). The address takes the root listing's public
 * form (`mcpPublicServerEndpoint`): the catalog's own URL for the catalog
 * entry, the origin alone for anything else, since a credential can ride in
 * a path, a query or a userinfo. Reduced here, before the snapshot is
 * written: the raw address is never stored.
 */
function profileMcpServerDto(server: HermesProfileMcpServer): RuntimeProfileMcpServerDto {
  const flag = { name: server.name, enabled: server.enabled };
  if (server.auth === undefined) return flag;
  const endpoint = mcpPublicServerEndpoint({ name: server.name, endpoint: server.endpoint ?? null, auth: server.auth });
  return { ...flag, endpoint, auth: server.auth, oauthTokenPresent: server.oauthTokenPresent ?? null };
}

/**
 * The live read of the profile inventory, the host part of `GET /profiles`.
 * The route serves it through the snapshot; the warm-up replays it on a
 * signal from the host, since the profiles carry the bots' MCP connections.
 */
export function liveProfilesRead(
  ctx: IntegrationRouteContext,
  runtime: { client: HermesClientConfig; linkFeatures?: string[] },
) {
  const { clientFactory, announcedFeatures } = ctx;
  return async () => {
    const client = clientFactory(runtime.client);
    let features: string[] | null;
    try {
      features = await announcedFeatures(runtime, client);
    } catch (error) {
      throw publicWriteError(error);
    }
    if (!features?.includes(RELAY_FEATURE_PROFILE_INVENTORY)) {
      throw new HttpError(404, "PROFILE_INVENTORY_UNAVAILABLE", "L’hôte de ce runtime n’annonce pas l’inventaire des profils.");
    }
    let inventory: HermesProfileInventory;
    try {
      inventory = await withDeadline(client.hostProfileInventory(), PROFILE_INVENTORY_TIMEOUT_MS);
    } catch (error) {
      throw publicWriteError(error);
    }
    return {
      features,
      // openedbot's own check profiles are not agents: never offered for import.
      profiles: inventory.profiles.filter((profile) => !OPENEDBOT_SERVICE_PROFILES.has(profile.name)).map((profile) => ({
        name: profile.name, displayName: profile.displayName, title: profile.title,
        description: profile.description, model: profile.model, hasAvatar: profile.hasAvatar,
        routineCount: profile.routines.length, routines: profile.routines,
        pinned: profile.uiMeta?.pinned === true, hidden: profile.uiMeta?.hidden === true,
        mcpServers: profile.mcpServers.map(profileMcpServerDto),
        ...(profile.mcpFacts ? { mcpFacts: true as const } : {}),
      })),
    };
  };
}
