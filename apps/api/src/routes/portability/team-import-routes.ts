import { Hono } from "hono";
import { ProfileImportError } from "@openedbot/roster/domain/profile-errors";
import { resolveImportedModel } from "@openedbot/roster/application/host-profile-model";
import { assertProfileNamesAvailable, lockProfileImports } from "@openedbot/roster/application/profile-reservations";
import { createImportedGroups, importHermesProfile } from "@openedbot/portability/application/roster";
import type { RuntimeProfileImportDto } from "@openedbot/contracts-api";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import type { BlobStore } from "../../infrastructure/blob-store";
import type { Db } from "@openedbot/platform-db";
import { isUniqueViolation, withTenant } from "@openedbot/platform-db";
import {
  HermesClientError,
  type HermesClient,
  type HermesClientConfig,
  type HermesModelOptions,
  type HermesProfileAvatar,
} from "@openedbot/hermes";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { hermesBundleImportRoutes } from "./hermes-bundle-import-routes";
import { OPENEDBOT_SERVICE_PROFILES } from "@openedbot/runtimes/domain/runtime-contract";
import { RELAY_FEATURE_PROFILE_INVENTORY } from "@openedbot/contracts-connector/features";

type RuntimeReader = typeof readRuntimeSecret;
type ProfileClient = Pick<HermesClient, "hostCapabilities" | "hostProfileInventory" | "hostProfileAvatar" | "probeProfileIsolation" | "modelOptions">;
const PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Agent imports into the roster: profiles read on the runtime's host
 * (`/runtime`) and Hermes bundles (`/hermes-bundle`).
 */
export function teamImportRoutes(
  db: Db,
  config: ApiConfig,
  dependencies: {
    readRuntime?: RuntimeReader;
    blobs?: BlobStore;
    clientFactory?: (clientConfig: HermesClientConfig) => ProfileClient;
  } = {},
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const readRuntime = dependencies.readRuntime ?? readRuntimeSecret;
  const blobs = dependencies.blobs;
  // The import writes with today's driver, and removes only what it has just written.
  const importBlobs = blobs && {
    driver: blobs.driver,
    put: (key: string, bytes: Uint8Array, contentType: string) => blobs.put(key, bytes, contentType),
    delete: (key: string) => blobs.delete(key, blobs.driver),
  };
  const clientFactory = dependencies.clientFactory ?? runtimeAdminClient;
  routes.route("/hermes-bundle", hermesBundleImportRoutes(db, config, readRuntime));

  routes.post("/runtime", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const unexpected = Object.keys(body).filter((key) => key !== "profiles" && key !== "sectionId");
    if (unexpected.length > 0) throw new HttpError(400, "TEAM_IMPORT_FIELDS_INVALID", "L’import contient des champs non autorisés.");
    if (!Array.isArray(body.profiles) || body.profiles.length === 0) {
      throw new HttpError(400, "PROFILE_IMPORT_EMPTY", "Choisissez au moins un profil à importer.");
    }
    const requested: string[] = [];
    for (const entry of body.profiles) {
      if (typeof entry !== "string" || !PROFILE_SLUG_PATTERN.test(entry) || entry === "default" || OPENEDBOT_SERVICE_PROFILES.has(entry)) {
        throw new HttpError(400, "PROFILE_SLUG_INVALID", "Un slug de profil est invalide.");
      }
      requested.push(entry);
    }
    if (new Set(requested).size !== requested.length) {
      throw new HttpError(400, "PROFILE_SLUG_AMBIGUOUS", "Le même profil est demandé plusieurs fois.");
    }
    const requestedSectionId = body.sectionId === undefined
      ? null
      : typeof body.sectionId === "string" && body.sectionId.trim()
        ? body.sectionId.trim()
        : (() => { throw new HttpError(400, "TEAM_SECTION_INVALID", "La section demandée est invalide."); })();

    const runtime = await readRuntime(db, config, auth.organizationId);
    if (!runtime) throw new HttpError(409, "RUNTIME_REQUIRED", "Enregistrez Hermes avant d’importer des agents.");
    const client = clientFactory(runtime.client);
    let features: string[] | null;
    try {
      features = await client.hostCapabilities();
    } catch (error) {
      throw profileHostError(error);
    }
    if (!features?.includes(RELAY_FEATURE_PROFILE_INVENTORY)) {
      throw new HttpError(404, "PROFILE_INVENTORY_UNAVAILABLE", "L’hôte de ce runtime n’annonce pas l’inventaire des profils.");
    }
    let catalog: Promise<HermesModelOptions> | undefined;
    const loadCatalog = () => catalog ??= client.modelOptions();
    const blobKeys: string[] = [];
    let callbackFailed = false;
    const dto = await withTenant(db, auth.organizationId, async (tx) => {
      try {
      await lockProfileImports(tx, auth.organizationId);
      await assertProfileNamesAvailable(tx, auth.organizationId, requested);
      // Read after acquiring the lock: never adopt a profile being compensated.
      const inventory = await client.hostProfileInventory();
      const byName = new Map(inventory.profiles.map((profile) => [profile.name, profile]));
      const already = await tx<Array<{ hermesProfile: string }>>`
        select hermes_profile as "hermesProfile" from bots
         where organization_id = ${auth.organizationId}
           and hermes_profile in (select jsonb_array_elements_text(${JSON.stringify(requested)}::text::jsonb))
      `;
      if (already.length > 0) {
        throw new HttpError(409, "PROFILE_ALREADY_IMPORTED", `Profil déjà importé : ${already[0]!.hermesProfile}`);
      }
      const slugTaken = await tx<Array<{ slug: string }>>`
        select slug from bots
         where organization_id = ${auth.organizationId}
           and slug in (select jsonb_array_elements_text(${JSON.stringify(requested)}::text::jsonb))
      `;
      if (slugTaken.length > 0) {
        throw new HttpError(409, "TEAM_SLUG_TAKEN", `Slug déjà utilisé : ${slugTaken[0]!.slug}`);
      }
      const sections = requestedSectionId
        ? await tx<Array<{ id: string }>>`
            select id from sections where organization_id = ${auth.organizationId} and id = ${requestedSectionId} limit 1
          `
        : await tx<Array<{ id: string }>>`
            select id from sections where organization_id = ${auth.organizationId} order by position asc limit 1
          `;
      const sectionId = sections[0]?.id;
      if (!sectionId) {
        throw new HttpError(requestedSectionId ? 404 : 409, requestedSectionId ? "TEAM_SECTION_NOT_FOUND" : "TEAM_SECTION_REQUIRED", requestedSectionId ? "Section introuvable." : "Créez une section avant l’import.");
      }
      const positions = await tx<Array<{ next: number }>>`
        select coalesce(max(position), -1) + 1 as next from bots
         where organization_id = ${auth.organizationId} and section_id = ${sectionId}
      `;
      const groupPositions = await tx<Array<{ next: number }>>`
        select coalesce(max(position), -1) + 1 as next from bot_groups
         where organization_id = ${auth.organizationId} and section_id = ${sectionId}
      `;
      let nextPosition = Number(positions[0]?.next ?? 0);
      const imported: RuntimeProfileImportDto["imported"] = [];
      const skipped: RuntimeProfileImportDto["skipped"] = [];
      const limitations: string[] = [];
      const routines: RuntimeProfileImportDto["routines"] = [];
      const groupMembers = new Map<string, Array<{ botId: string; slug: string }>>();
      for (const slug of requested) {
        const profile = byName.get(slug);
        if (!profile) { skipped.push({ slug, reason: "not-in-inventory" }); continue; }
        const resolved = await resolveImportedModel(profile, runtime, loadCatalog);
        limitations.push(...resolved.limitations);
        let isolated = false;
        try {
          isolated = await clientFactory({ ...runtime.client, profile: slug }).probeProfileIsolation(slug) === "isolated";
        } catch { /* The worker will also fail closed if isolation remains unproven. */ }
        limitations.push(`${isolated ? "capabilities-live-on-profile" : "memory-restricted"}:${slug}`);
        let avatar: HermesProfileAvatar | null = null;
        if (profile.hasAvatar && blobs) {
          try { avatar = await client.hostProfileAvatar(slug); } catch { /* Reported by the shared importer. */ }
        }
        const result = await importHermesProfile(tx, {
          organizationId: auth.organizationId, userId: auth.userId, sectionId,
          position: nextPosition++, managed: false, model: resolved.model, blobKeys,
        }, profile, avatar, importBlobs);
        imported.push({ slug, botId: result.botId, threadId: result.threadId, name: result.name });
        routines.push(...result.routines);
        limitations.push(...result.limitations);
        for (const group of result.groups) {
          const members = groupMembers.get(group) ?? [];
          members.push({ botId: result.botId, slug });
          groupMembers.set(group, members);
        }
      }
      const grouped = await createImportedGroups(tx, {
        organizationId: auth.organizationId, sectionId, position: Number(groupPositions[0]?.next ?? 0),
      }, groupMembers);
      limitations.push(...grouped.limitations);
      return { imported, skipped, groups: grouped.groups, routines, limitations } satisfies RuntimeProfileImportDto;
      } catch (error) { callbackFailed = true; throw error; }
    }).catch(async (error) => {
      if (callbackFailed && blobs) await Promise.allSettled(blobKeys.map((key) => blobs.delete(key, blobs.driver)));
      if (error instanceof ProfileImportError) throw new HttpError(error.status, error.code, error.message, {}, error.details);
      if (error instanceof HttpError) throw error;
      if (isUniqueViolation(error)) throw new HttpError(409, "PROFILE_ALREADY_IMPORTED", "Un profil de cet import est déjà lié à un bot.");
      throw profileHostError(error);
    });
    return context.json(dto, 201);
  });
  return routes;
}

function profileHostError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof HermesClientError) {
    if (error.code === "HERMES_OPERATOR_UNAVAILABLE" || error.code === "HERMES_LINK_PATH_FORBIDDEN") {
      return new HttpError(404, "PROFILE_INVENTORY_UNAVAILABLE", "L’hôte de ce runtime n’annonce pas l’inventaire des profils.");
    }
    return new HttpError(502, "RUNTIME_ADMIN_UNAVAILABLE", "L’hôte du runtime n’a pas pu réaliser cette opération.");
  }
  return new HttpError(502, "RUNTIME_ADMIN_UNAVAILABLE", "L’hôte du runtime n’a pas pu réaliser cette opération.");
}
