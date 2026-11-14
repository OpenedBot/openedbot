import { recordRuntimeHealthObservation } from "@openedbot/runtimes/application/runtime-health";
import { ProfileImportError } from "@openedbot/roster/domain/profile-errors";
import {
  resolvedHostProfileModel as resolveProfileModel,
  type HostProfileModelSelection,
} from "@openedbot/roster/application/host-profile-model";
import { Hono } from "hono";
import { setModelAssignmentMode } from "@openedbot/identity/application/organizations";
import {
  HermesClientError,
  hermesProviderAcceptsApiKey,
  type HermesClient,
  hermesProviderAcceptsOauth,
  type HermesModelOptions,
  type HermesProviderSdk,
  type HermesClientConfig,
} from "@openedbot/hermes";
import { runtimeAdminClient, type RuntimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import {
  OPENAI_FREE_TIER_PROVIDER,
  openAiFreeTokensPerDay,
} from "@openedbot/runtimes/domain/runtime/openai-free-tier";
import { isKeylessProvider } from "@openedbot/runtimes/domain/runtime/keyless-providers";
import {
  isHermesReasoningEffort,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import type { ModelAssignmentMode, RuntimeModelCatalogDto, RuntimeModelSelectionInput } from "@openedbot/contracts-api";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { effectiveAdminMode, readOrganizationRuntimeMode } from "@openedbot/runtimes/application/runtime-mode";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { invalidateSnapshots, postgresSnapshotStore, readThrough, wantsFreshRead, type SnapshotStore } from "@openedbot/runtimes/application/runtime-read-snapshots";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import {
  linkPublication,
  publicRuntimeWithBots,
  type RuntimeRow,
} from "./runtime-routes";
import { readRuntimeRowById, readRuntimeRows } from "@openedbot/runtimes/application/runtime-rows";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { cancelModelSelectionProof, enqueueModelSelectionProof } from "@openedbot/runtimes/application/model-selection-proof";
import { readProvenRuntimeModel } from "@openedbot/runtimes/application/model-selection-proof";
import { followingInDb, startProfileModelSync } from "@openedbot/roster/application/bot-model-reset";
import { RELAY_FEATURE_PROFILE_MODEL_BATCH, RELAY_FEATURE_PROVIDER_SDKS } from "@openedbot/contracts-connector/features";
import { resolveRunnableSelection } from "@openedbot/execution/domain/run-selection";
import { loadActiveIncidents } from "@openedbot/execution/application/provider-fallback";

const ALWAYS_AUTHENTICATED_PROVIDERS = new Set(["moa"]);
export async function resolvedHostProfileModel(
  bot: { model?: string | null; provider?: string | null },
  runtime: { selectedProvider?: string | null; selectedModel?: string | null },
  loadCatalog: () => Promise<Pick<HermesModelOptions, "providers">>,
): Promise<HostProfileModelSelection | null> {
  try { return await resolveProfileModel(bot, runtime, loadCatalog); }
  catch (error) {
    if (error instanceof ProfileImportError) throw new HttpError(error.status, error.code, error.message);
    throw error;
  }
}

export type RuntimeModelSelection = {
  provider: string | null;
  model: string | null;
  reasoningEffort: HermesReasoningEffort | null;
};

function publicModelSelectionState(proof: { status: "queued" | "running" | "failed"; provider: string | null; model: string | null; reasoning_effort: string | null; requested_at: Date; attempts: number; next_attempt_at: Date | null; error: { code: string; message: string } | null }) {
  return { status: proof.status, provider: proof.provider, model: proof.model,
    reasoningEffort: proof.reasoning_effort as HermesReasoningEffort | null,
    requestedAt: proof.requested_at.toISOString(), attempts: proof.attempts,
    nextAttemptAt: proof.next_attempt_at?.toISOString() ?? null, error: proof.error };
}

export function runtimeModelSelection(input: RuntimeModelSelectionInput): RuntimeModelSelection {
  const provider = normalizedOptional(input.provider, 120, "Le fournisseur");
  const model = normalizedOptional(input.model, 200, "Le modèle");
  const rawEffort = normalizedOptional(input.reasoningEffort, 40, "L’effort de raisonnement");
  if (rawEffort !== null && !isHermesReasoningEffort(rawEffort)) {
    throw new HttpError(400, "RUNTIME_REASONING_EFFORT_INVALID", "Effort de raisonnement inconnu.");
  }
  return { provider, model, reasoningEffort: rawEffort };
}

/**
 * The provider SDKs installed on the host, or `null` when it is not known:
 * the host does not advertise `provider_sdks`, or the read failed. An unknown SDK
 * blocks nothing; only an SDK proven absent makes a provider unusable.
 */
export async function readProviderSdks(
  row: Pick<RuntimeRow, "linkFeatures">,
  client: Pick<HermesClient, "hostProviderSdks">,
): Promise<HermesProviderSdk[] | null> {
  if (!row.linkFeatures?.includes(RELAY_FEATURE_PROVIDER_SDKS)) return null;
  return client.hostProviderSdks().catch(() => null);
}

export function runtimeModelCatalog(
  row: RuntimeRow,
  catalog: HermesModelOptions,
  sdks: HermesProviderSdk[] | null = null,
): RuntimeModelCatalogDto {
  const sdkInstalled = (slug: string): boolean | null =>
    sdks?.find((entry) => entry.provider === slug)?.installed ?? null;
  const sdkInstallable = (slug: string): boolean | null =>
    sdks?.find((entry) => entry.provider === slug)?.installable ?? null;
  // A connector runtime has no URL: no profile is deduced from it.
  const hermesProfile = row.reachability === "direct" || row.endpoint === null ? null : hermesProfileFromBaseUrl(row.endpoint);
  const usable = new Set(
    catalog.providers
      .filter((provider) =>
        provider.authenticated && !ALWAYS_AUTHENTICATED_PROVIDERS.has(provider.slug) && sdkInstalled(provider.slug) !== false)
      .map((provider) => provider.slug),
  );
  return {
    runtimeId: row.id,
    runtimeName: row.name,
    hermesProfile,
    currentProvider: catalog.provider,
    runtimeDefaultModel: catalog.model,
    hasUsableProvider: usable.size > 0,
    runtimeConfigWritable: false,
    providers: catalog.providers.map((provider) => ({
      slug: provider.slug,
      name: provider.name,
      isCurrent: provider.isCurrent,
      authenticated: provider.authenticated,
      alwaysAuthenticated: ALWAYS_AUTHENTICATED_PROVIDERS.has(provider.slug),
      provesInference: usable.has(provider.slug),
      // An anonymous tier declares itself `api_key` on the Hermes side for lack of another type:
      // offering it a key field would send a bearer the relay refuses.
      acceptsApiKey: !isKeylessProvider(provider.slug) && hermesProviderAcceptsApiKey(provider),
      acceptsOauth: hermesProviderAcceptsOauth(provider),
      sdkInstalled: sdkInstalled(provider.slug),
      sdkInstallable: sdkInstallable(provider.slug),
      warning: provider.warning,
      authCommand: provider.authenticated
        ? null
        : hermesProfile
          ? `make bot-auth SLUG=${hermesProfile}`
          : `hermes auth add ${provider.slug}`,
      models: provider.models.map((model) => ({
        id: model.id,
        fast: model.fast,
        reasoning: model.reasoning,
        isRuntimeDefault: provider.slug === catalog.provider && model.id === catalog.model,
        freeTier: provider.slug === OPENAI_FREE_TIER_PROVIDER
          ? { tokensPerDay: openAiFreeTokensPerDay(model.id) }
          : null,
      })),
    })),
  };
}

/**
 * What the worker sends for a bot that has no model of its own: the composer
 * and the settings name it instead of « Aucun modèle » while Hermes answers
 * anyway. Computed on every response, outside the snapshot: a quota recorded
 * by the worker a second ago, or a snapshot stored before the field, must not
 * name a provider the next run will route around.
 */
export function withAutomaticModel(
  dto: RuntimeModelCatalogDto,
  runtime: { selectedProvider: string | null; selectedModel: string | null },
  incidents: ReadonlyArray<{ provider: string; until: Date | string; kind?: "quota" | "auth" }>,
): RuntimeModelCatalogDto {
  const automatic = resolveRunnableSelection(
    { provider: dto.currentProvider, model: dto.runtimeDefaultModel, providers: dto.providers },
    { provider: runtime.selectedProvider, model: runtime.selectedModel, reasoningEffort: null },
    incidents,
    { provider: runtime.selectedProvider, model: runtime.selectedModel },
  );
  return {
    ...dto,
    automaticModel: automatic?.provider && automatic.model
      ? {
        provider: automatic.provider,
        model: automatic.model,
        source: automatic.provider === dto.currentProvider && automatic.model === dto.runtimeDefaultModel ? "host" : "openedbot",
      }
      : null,
  };
}

// The selection is written to the database only if the live Hermes catalog confirms it: a provider
// that has disappeared or disconnected would otherwise be persisted, then break the following runs.
export async function catalogValidatedSelection(
  selection: RuntimeModelSelection,
  loadCatalog: () => Promise<RuntimeModelCatalogDto>,
): Promise<RuntimeModelSelection> {
  // provider null = « laisser Hermes décider »: it is persisted as-is, without querying the runtime.
  if (selection.provider === null) return selection;
  const catalog = await loadCatalog();
  const provider = catalog.providers.find((entry) => entry.slug === selection.provider);
  if (!provider) {
    throw new HttpError(
      409,
      "RUNTIME_MODEL_PROVIDER_UNKNOWN",
      "Ce fournisseur n’est plus disponible dans le catalogue Hermes.",
    );
  }
  if (provider.sdkInstalled === false) {
    throw new HttpError(
      409,
      "RUNTIME_MODEL_PROVIDER_SDK_MISSING",
      provider.sdkInstallable
        ? "Le connecteur de ce fournisseur n’est pas installé sur votre serveur : relancez « sudo edge-setup up » pour l’installer, ou choisissez un autre fournisseur."
        : "Le connecteur de ce fournisseur n’est pas installé sur votre serveur et l’installation edge-setup ne le fournit pas : choisissez un autre fournisseur.",
    );
  }
  if (!provider.authenticated && !provider.alwaysAuthenticated) {
    throw new HttpError(
      409,
      "RUNTIME_MODEL_PROVIDER_UNAUTHENTICATED",
      `${provider.name} doit être connecté dans Hermes avant de pouvoir être sélectionné.`,
    );
  }
  const model = selection.model === null
    ? undefined
    : provider.models.find((entry) => entry.id === selection.model);
  if (!model) {
    throw new HttpError(
      409,
      "RUNTIME_MODEL_UNAVAILABLE",
      "Ce modèle n’est pas proposé par ce fournisseur dans le catalogue Hermes.",
    );
  }
  // A reasoning effort on a model that does not reason is ignored rather than refused.
  return { ...selection, reasoningEffort: model.reasoning ? selection.reasoningEffort : null };
}

/**
 * Only the effort changes: the recorded provider + model pair has already passed
 * the inference test, and the catalog reread just before proves it is still
 * offered and connected. Redoing the test run would prove nothing more.
 */
export function isEffortOnlyChange(
  stored: { selectedProvider: string | null; selectedModel: string | null },
  selection: RuntimeModelSelection,
): boolean {
  return selection.provider !== null && selection.model !== null &&
    selection.provider === stored.selectedProvider && selection.model === stored.selectedModel;
}

export function hermesProfileFromBaseUrl(baseUrl: string): string | null {
  try {
    return /^\/p\/([a-z0-9][a-z0-9-]*)\/?$/.exec(new URL(baseUrl).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function runtimeModelRoutes(db: Db, config: ApiConfig, dependencies: { snapshotStore?: SnapshotStore } = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const snapshots = dependencies.snapshotStore ?? postgresSnapshotStore(db);
  routes.get("/:runtimeId/models", async (context) => {
    const auth = context.get("auth");
    const { row, client } = await resolveRuntime(db, config, auth.organizationId, context.req.param("runtimeId"));
    const dto = await readThrough(snapshots, {
      organizationId: auth.organizationId, runtimeId: row.id, kind: "models",
      fresh: wantsFreshRead(context.req.query("fresh")),
      // A selection the worker promoted bumps updated_at; the worker cannot
      // invalidate this table, so an older snapshot is ignored here.
      notOlderThan: row.updatedAt ? new Date(row.updatedAt) : null,
      read: async () => {
    // This read is the most frequent contact with the runtime: it
    // sets its health verdict, otherwise `last_health_status` moves only on the
    // « Tester » click and stays stale (Hermes back and still `unreachable`,
    // Hermes dead and still `healthy`). A failed write never replaces
    // the response (see `recordRuntimeHealthObservation`).
    try {
      const catalog = await client.modelOptions();
      await recordRuntimeHealthObservation(db, auth.organizationId, row, null);
      // No incident is cleared by this read. `authenticated` says a
      // credential is stored, not that it is alive (a revoked refresh token
      // stays `authenticated`) nor that its quota is back: a rate-limited
      // pool stays listed as logged in, and clearing its `quota` here put it
      // back in the worker's resolution on every visit of the settings, so the
      // next run hit the same 429. An incident falls at its deadline, on a
      // successful run, on a proven reconnection or on a proven selection.
      return runtimeModelCatalog(row, catalog, await readProviderSdks(row, client));
    } catch (error) {
      const mapped = mapHermesError(error);
      // Only an error born at the Hermes boundary counts as a verdict: a code
      // bug or an SQL error says nothing about the runtime, nothing is written. And
      // a request that NEVER LEFT (`not_sent`: relay saturated, route not
      // relayed, cancellation before send) observed nothing of the runtime
      // either: an `unreachable` set there would stay wrong until someone
      // clicks « Tester », since the heartbeat only reports `disconnected`.
      if (error instanceof HermesClientError && error.requestDelivery !== "not_sent") {
        await recordRuntimeHealthObservation(db, auth.organizationId, row, mapped);
      }
      throw mapped;
    }
      },
    });
    const incidents = await loadActiveIncidents(db, auth.organizationId, row.id);
    return context.json<RuntimeModelCatalogDto>(withAutomaticModel(dto, row, incidents));
  });

  routes.put("/:runtimeId/model-selection", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    let selection = runtimeModelSelection(await jsonBody(context.req.raw));
    const runtimeId = context.req.param("runtimeId");
    const resolved = await resolveRuntime(db, config, auth.organizationId, runtimeId);
    const adminMode = effectiveAdminMode(
      config,
      await readOrganizationRuntimeMode(db, config, auth.organizationId),
    );
    const effortOnly = isEffortOnlyChange(resolved.row, selection);
    try {
      if (selection.provider !== null) {
        const [options, sdks] = await Promise.all([
          resolved.client.modelOptions(),
          readProviderSdks(resolved.row, resolved.client),
        ]);
        selection = await catalogValidatedSelection(selection, async () => runtimeModelCatalog(resolved.row, options, sdks));
      }
    } catch (error) {
      throw mapHermesError(error);
    }
    if (effortOnly) {
      const updated = await withTenant(db, auth.organizationId, async (tx) => {
        const rows = await tx<Array<{ reasoningEffort: string | null; updatedAt: Date }>>`
          update runtimes set reasoning_effort = ${selection.reasoningEffort}, updated_at = now()
          where organization_id = ${auth.organizationId} and id = ${runtimeId}
            and selected_provider = ${resolved.row.selectedProvider} and selected_model = ${resolved.row.selectedModel}
          returning reasoning_effort as "reasoningEffort", updated_at as "updatedAt"
        `;
        if (!rows[0]) return null;
        await tx`delete from runtime_model_selection_proofs where organization_id = ${auth.organizationId} and runtime_id = ${runtimeId}`;
        return rows[0];
      });
      if (updated) {
        const row = { ...resolved.row, ...updated };
        await invalidateSnapshots(snapshots, auth.organizationId, "models");
        return context.json({ ...await publicRuntimeWithBots(db, auth.organizationId, row, adminMode, [], config.connectorVersions, null, linkPublication(config)), modelSelection: null });
      }
    }
    if (selection.provider !== null && selection.model !== null) {
      const promoted = await withTenant(db, auth.organizationId, async (tx) => {
        const proven = await readProvenRuntimeModel(tx, auth.organizationId, runtimeId, selection.provider!, selection.model!);
        if (!proven) return null;
        const rows = await tx<RuntimeRow[]>`update runtimes set selected_provider = ${selection.provider}, selected_model = ${selection.model}, reasoning_effort = ${selection.reasoningEffort}, updated_at = now()
          where organization_id = ${auth.organizationId} and id = ${runtimeId}
          returning id, name, reachability, endpoint, token_ciphertext as "tokenCiphertext", token_nonce as "tokenNonce",
            token_tag as "tokenTag", token_key_id as "tokenKeyId", edge_auth_ciphertext as "edgeAuthCiphertext",
            edge_auth_nonce as "edgeAuthNonce", edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId",
            link_connected_at as "linkConnectedAt", link_last_seen_at as "linkLastSeenAt", link_generation::text as "linkGeneration",
            link_agent as "linkAgent", link_agent_seen_at as "linkAgentSeenAt", link_hermes_version as "linkHermesVersion", link_origin as "linkOrigin",
            link_features as "linkFeatures", link_token_rotated_at as "linkRotatedAt",
            (select max(e.occurred_at) from runtime_link_events e where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'replaced') as "linkLastReplacedAt",
            (select max(e.occurred_at) from runtime_link_events e where e.organization_id = runtimes.organization_id and e.runtime_id = runtimes.id and e.kind = 'hijack_suspected') as "linkHijackSuspectedAt",
            selected_provider as "selectedProvider",
            selected_model as "selectedModel", reasoning_effort as "reasoningEffort", capacity,
            last_health_status as "lastHealthStatus", last_health_error as "lastHealthError", last_probed_at as "lastProbedAt",
            is_active as "isActive", created_at as "createdAt", updated_at as "updatedAt"
        `;
        if (!rows[0]) return null;
        await tx`delete from runtime_model_selection_proofs where organization_id = ${auth.organizationId} and runtime_id = ${runtimeId}`;
        await tx`delete from runtime_provider_incidents where organization_id = ${auth.organizationId} and runtime_id = ${runtimeId} and provider = ${selection.provider}`;
        return rows[0];
      });
      if (promoted) {
        const candidates = await withTenant(db, auth.organizationId, (tx) => tx<Array<{ botId: string; profile: string }>>`
          select b.id as "botId", b.hermes_profile as "profile" from bots b
           where b.organization_id = ${auth.organizationId} and b.hermes_profile_managed = true
             and b.hermes_profile is not null and b.deleted_at is null
             and coalesce((select p.status from bot_profile_provisions p
                            where p.organization_id = b.organization_id and p.bot_id = b.id), 'succeeded') = 'succeeded'
        `);
        const current = await withTenant(db, auth.organizationId, async (tx) =>
          (await readRuntimeRowById(tx, auth.organizationId, runtimeId))[0] ?? null);
        const profileModelSync = candidates.length === 0 || !current ? null : startProfileModelSync(auth.organizationId, candidates, {
          client: resolved.client,
          runtime: { selectedProvider: current?.selectedProvider ?? null, selectedModel: current?.selectedModel ?? null },
          batch: resolved.row.linkFeatures?.includes(RELAY_FEATURE_PROFILE_MODEL_BATCH) ?? false,
          stillFollowing: followingInDb(db, auth.organizationId),
        }, "global_selection");
        await invalidateSnapshots(snapshots, auth.organizationId, "models");
        return context.json({ ...await publicRuntimeWithBots(db, auth.organizationId, promoted, adminMode, [], config.connectorVersions, null, linkPublication(config)), modelSelection: null, profileModelSync });
      }
    }
    const proof = await enqueueModelSelectionProof(db, { organizationId: auth.organizationId, runtimeId, ...selection });
    await invalidateSnapshots(snapshots, auth.organizationId, "models");
    return context.json({
      ...await publicRuntimeWithBots(db, auth.organizationId, resolved.row, adminMode, [], config.connectorVersions, null, linkPublication(config)),
      modelSelection: publicModelSelectionState(proof),
    }, 202);
  });

  routes.delete("/:runtimeId/model-selection/pending", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const resolved = await resolveRuntime(db, config, auth.organizationId, context.req.param("runtimeId"));
    await cancelModelSelectionProof(db, auth.organizationId, resolved.row.id);
    const adminMode = effectiveAdminMode(config, await readOrganizationRuntimeMode(db, config, auth.organizationId));
    return context.json({ ...await publicRuntimeWithBots(db, auth.organizationId, resolved.row, adminMode, [], config.connectorVersions, null, linkPublication(config)), modelSelection: null });
  });

  /**
   * The model attribution mode, recorded on the organization.
   *
   * Write only: the read travels with the rest of the configuration
   * (`GET /api/runtime`), so that the models screen and the composer see the
   * same value with no extra request.
   *
   * Switching touches no bot. `global` puts the bots' own models to
   * sleep, it does not erase them: it is the run's resolution that ignores them,
   * and switching back to `per_bot` restores them as they are.
   */
  routes.put("/assignment-mode", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const mode = modelAssignmentMode(await jsonBody(context.req.raw));
    const updated = await withTenant(db, auth.organizationId, (tx) => setModelAssignmentMode(tx, auth.organizationId, mode));
    if (updated === null) throw new HttpError(404, "ORGANIZATION_NOT_FOUND", "Organisation introuvable.");
    return context.json({ modelAssignmentMode: updated as ModelAssignmentMode });
  });

  return routes;
}

/** An unknown mode is refused rather than brought back to the default: the client would otherwise believe its choice was taken. */
export function modelAssignmentMode(input: unknown): ModelAssignmentMode {
  const mode = (input as { mode?: unknown } | null)?.mode;
  if (mode === "global" || mode === "per_bot") return mode;
  throw new HttpError(400, "MODEL_ASSIGNMENT_MODE_INVALID", "Le mode d’attribution des modèles est inconnu.");
}

export async function resolveRuntime(
  db: Db,
  config: ApiConfig,
  organizationId: string,
  runtimeId: string,
): Promise<{ row: RuntimeRow; client: RuntimeAdminClient; clientConfig: HermesClientConfig }> {
  const row = await withTenant(db, organizationId, async (tx) => {
    const rows = await readRuntimeRows(tx, organizationId);
    return rows.find((entry) => entry.id === runtimeId) ?? null;
  });
  if (!row) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Runtime introuvable.");
  const secret = await readRuntimeSecret(db, config, organizationId);
  if (!secret || secret.id !== runtimeId) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Runtime introuvable.");
  return { row, client: runtimeAdminClient(secret.client), clientConfig: secret.client };
}

function normalizedOptional(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "VALIDATION_ERROR", `${label} est invalide.`);
  const normalized = value.trim();
  if (normalized.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} est trop long.`);
  return normalized || null;
}

function mapHermesError(error: unknown): HttpError {
  if (error instanceof HermesClientError) return new HttpError(error.status, error.code, error.message);
  if (error instanceof HttpError) return error;
  // Measured on 04-09: an SQL error thrown AFTER the Hermes round trip (an array badly
  // typed in an `= any(...)`) came out as « Hermes inaccessible » and made one
  // look for a link failure that did not exist. Only a transport
  // error carries this code; the rest comes back as-is (500 logged).
  if (error instanceof Error && /postgres|sql|syntax|column|relation|operator/i.test(`${error.name} ${error.message}`)) {
    throw error;
  }
  return new HttpError(502, "HERMES_UNREACHABLE", "Le runtime Hermes est inaccessible.");
}
