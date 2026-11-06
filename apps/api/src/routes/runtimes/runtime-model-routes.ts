import { recordRuntimeHealthObservation } from "@openedbot/runtimes/application/runtime-health";
import { ProfileImportError } from "@openedbot/portability/domain/errors";
import {
  resolvedHostProfileModel as resolveProfileModel,
  type HostProfileModelSelection,
} from "@openedbot/portability/application/model";
import { Hono } from "hono";
import { setModelAssignmentMode } from "@openedbot/identity/sql/organizations";
import {
  HermesClient,
  HermesClientError,
  hermesProviderAcceptsApiKey,
  hermesProviderAcceptsOauth,
  type HermesModelOptions,
  type HermesProviderSdk,
  type HermesClientConfig,
} from "@openedbot/hermes";
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
import { pgTextArray } from "@openedbot/runtime-link/application/broker";
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
import { readRuntimeRowById, readRuntimeRows } from "@openedbot/runtimes/sql/runtime-rows";
import { readRuntimeSecret } from "@openedbot/runtimes/application/runtime-access";
import { cancelModelSelectionProof, enqueueModelSelectionProof } from "@openedbot/runtimes/application/model-selection-proof";
import { readProvenRuntimeModel } from "@openedbot/runtimes/sql/model-selection-proofs";
import { followingInDb, startProfileModelSync } from "@openedbot/roster/application/bot-model-reset";
import { RELAY_FEATURE_PROFILE_MODEL_BATCH, RELAY_FEATURE_PROVIDER_SDKS } from "@openedbot/contracts-connector/features";

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
 * Les SDK fournisseur installés sur l'hôte, ou `null` quand on ne sait pas :
 * l'hôte n'annonce pas `provider_sdks`, ou la lecture a échoué. Un SDK inconnu
 * n'empêche rien, seul un SDK prouvé absent rend un fournisseur inutilisable.
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
  // Un runtime connector n'a pas d'URL : aucun profil ne s'en déduit.
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
      // Un tier anonyme se déclare `api_key` côté Hermes faute d'autre type :
      // lui offrir un champ de clé enverrait un bearer que le relais refuse.
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

// La sélection ne part en base que si le catalogue Hermes vivant la confirme : un fournisseur
// disparu ou déconnecté serait autrement persisté, puis casserait les runs suivants.
export async function catalogValidatedSelection(
  selection: RuntimeModelSelection,
  loadCatalog: () => Promise<RuntimeModelCatalogDto>,
): Promise<RuntimeModelSelection> {
  // provider null = « laisser Hermes décider » : on persiste tel quel, sans interroger le runtime.
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
  // Un effort de raisonnement sur un modèle qui ne raisonne pas est ignoré plutôt que refusé.
  return { ...selection, reasoningEffort: model.reasoning ? selection.reasoningEffort : null };
}

/**
 * Seul l'effort change : le couple fournisseur + modèle enregistré a déjà passé
 * le test d'inférence, et le catalogue relu juste avant prouve qu'il est encore
 * proposé et connecté. Refaire le run de test ne prouverait rien de plus.
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
    // Cette lecture est le contact le plus fréquent avec le runtime : elle
    // pose son verdict de santé, sinon `last_health_status` ne bouge qu'au
    // clic « Tester » et reste périmé (Hermes revenu encore `unreachable`,
    // Hermes mort encore `healthy`). Une écriture en échec ne remplace jamais
    // la réponse (voir `recordRuntimeHealthObservation`).
    try {
      const catalog = await client.modelOptions();
      await recordRuntimeHealthObservation(db, auth.organizationId, row, null);
      const authenticated = catalog.providers
        .filter((provider) => provider.authenticated && !ALWAYS_AUTHENTICATED_PROVIDERS.has(provider.slug))
        .map((provider) => provider.slug);
      // Seul un incident `quota` se lève ici. `authenticated` dit qu'un
      // credential est stocké, pas qu'il vit : un refresh token révoqué reste
      // `authenticated`, et effacer l'incident `auth` repassait l'affichage au
      // vert à chaque lecture. Un `auth` tombe sur une reconnexion prouvée, un
      // run réussi ou son échéance.
      if (authenticated.length > 0) {
        await withTenant(db, auth.organizationId, async (tx) => {
          await tx`
            delete from runtime_provider_incidents
             where organization_id = ${auth.organizationId} and runtime_id = ${row.id}
               and provider = any(${pgTextArray(authenticated)}::text[])
               and kind = 'quota'
          `;
        });
      }
      return runtimeModelCatalog(row, catalog, await readProviderSdks(row, client));
    } catch (error) {
      const mapped = mapHermesError(error);
      // Seule une erreur née à la frontière Hermes vaut verdict : un bug de
      // code ou une erreur SQL ne dit rien du runtime, on n'écrit rien. Et
      // une requête JAMAIS PARTIE (`not_sent` : relais saturé, route non
      // relayée, annulation avant envoi) n'a rien observé du runtime non
      // plus : un `unreachable` posé là resterait faux tant que personne ne
      // clique « Tester », puisque le heartbeat ne relève que `disconnected`.
      if (error instanceof HermesClientError && error.requestDelivery !== "not_sent") {
        await recordRuntimeHealthObservation(db, auth.organizationId, row, mapped);
      }
      throw mapped;
    }
      },
    });
    return context.json<RuntimeModelCatalogDto>(dto);
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
   * Le mode d'attribution des modèles, enregistré à l'organisation.
   *
   * Écriture seule : la lecture voyage avec le reste de la configuration
   * (`GET /api/runtime`), pour que l'écran des modèles et le composer voient la
   * même valeur sans requête de plus.
   *
   * Basculer ne touche à aucun bot. `global` met les modèles propres en
   * sommeil, il ne les efface pas : c'est la résolution du run qui les ignore,
   * et repasser en `per_bot` les restitue tels quels.
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

/** Un mode inconnu est refusé plutôt que ramené au défaut : le client saurait autrement croire son choix pris. */
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
): Promise<{ row: RuntimeRow; client: HermesClient; clientConfig: HermesClientConfig }> {
  const row = await withTenant(db, organizationId, async (tx) => {
    const rows = await readRuntimeRows(tx, organizationId);
    return rows.find((entry) => entry.id === runtimeId) ?? null;
  });
  if (!row) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Runtime introuvable.");
  const secret = await readRuntimeSecret(db, config, organizationId);
  if (!secret || secret.id !== runtimeId) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Runtime introuvable.");
  return { row, client: new HermesClient(secret.client), clientConfig: secret.client };
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
  // Mesuré le 04-09 : une erreur SQL levée APRÈS l'aller Hermes (tableau mal
  // typé dans un `= any(...)`) sortait en « Hermes inaccessible » et faisait
  // chercher une panne de lien qui n'existait pas. Seule une erreur de
  // transport porte ce code ; le reste remonte tel quel (500 journalisé).
  if (error instanceof Error && /postgres|sql|syntax|column|relation|operator/i.test(`${error.name} ${error.message}`)) {
    throw error;
  }
  return new HttpError(502, "HERMES_UNREACHABLE", "Le runtime Hermes est inaccessible.");
}
