import { Hono } from "hono";
import { type HermesProfileInventory } from "@openedbot/hermes";
import { OPENEDBOT_SERVICE_PROFILES } from "@openedbot/runtimes/domain/runtime-contract";
import type {
  RuntimeHostProfileDto,
  RuntimeProfileDeleteDto,
  RuntimeProfileDeleteJobDto,
  RuntimeProfileDeleteJobListDto,
  RuntimeProfileInventoryDto,
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

/** Les profils Hermes de l’hôte : inventaire, et suppressions par lot ou à l’unité. */
export function runtimeProfileRoutes(ctx: IntegrationRouteContext): Hono<{ Variables: AppVariables }> {
  const { db, config, readRuntime, clientFactory, snapshots, announcedFeatures, requireWritableRuntimeWithId } = ctx;
  const routes = new Hono<{ Variables: AppVariables }>();

  /** Inventaire public des profils Hermes annoncé par l'hôte. */
  routes.get("/profiles", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtime = await readRuntime(db, config, auth.organizationId);
    if (!runtime) {
      throw new HttpError(404, "RUNTIME_REQUIRED", "Aucun runtime Hermes actif : il n’y a rien à lire.");
    }
    const client = clientFactory(runtime.client);
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
      read: async () => {
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
            mcpServers: profile.mcpServers.map((server) => ({ name: server.name, enabled: server.enabled })),
          })),
        };
      },
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
      // Un instantané écrit avant ce champ ne le porte pas.
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
   * File un lot de suppressions vers le worker. La réponse 202 rend le job ;
   * le client poll GET /profiles/delete-jobs. La table et les onglets restent
   * utilisables pendant que l'hôte est lu et effacé, slug par slug.
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
   * Suppression d'un profil sur le disque de l'hôte. Si un bot (y compris
   * archivé) porte ce hermes_profile, ses sessions runtime partent d'abord ;
   * un échec de purge ou une relue qui voit encore le slug laisse la ligne SQL.
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
      // Le verrou d'import est tenu pendant toute la suppression : un import
      // ne réserve pas ce slug entre la vérification et le DELETE distant.
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
