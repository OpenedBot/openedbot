import type { SQL } from "bun";
import {
  type HermesClient,
  HermesClientError,
  type HermesModelOption,
  type HermesModelOptions,
} from "@openedbot/hermes";
import { NO_USABLE_PROVIDER_CODE } from "@openedbot/contracts-errors";
import { NO_USABLE_PROVIDER_MESSAGE } from "../../domain/hermes-events";
import type { ModelAssignmentMode } from "@openedbot/contracts-api";
import { defaultTierModel } from "@openedbot/runtimes/domain/runtime/default-model";
import { isVirtualAggregateProvider } from "../../domain/provider-failure";
import {
  applyFallbackProfileModel,
  enqueueQuotaReachedEmail,
  fallbackFailureMessage,
  loadActiveIncidents,
  planProviderRetry,
  PROFILE_MANAGEMENT_FEATURE,
  providerAuthRequiredPayload,
  providerFallbackPayload,
  PROVIDER_FALLBACK_EVENT,
  recordProviderIncident,
  type ProviderRetryState,
} from "../provider-fallback";
import { rememberWarmModelSelection } from "../warm-model-selection";
import type { WorkerConfig } from "../worker-config";
import { NamedRunError } from "./failure";
import { persistUnnumberedEvents } from "./persist";
import type { RunContext } from "./types";
import { describe, log } from "./util";

/**
 * Le couple que ce run demandera, selon le mode d'attribution de l'organisation.
 *
 * `per_bot` : le modèle du bot prime, et son fournisseur reste implicite pour
 * que `resolveRunnableSelection` aille chercher celui qui le sert vraiment (un
 * même id est listé par plusieurs fournisseurs). Le choix global ne sert qu'aux
 * bots qui n'ont rien.
 *
 * `global` : le choix global l'emporte, fournisseur compris. Le modèle propre du
 * bot n'est pas lu, mais il n'est pas perdu non plus : il dort en base et
 * revient dès que l'organisation repasse en `per_bot`. Sans choix global posé,
 * il n'y a rien à imposer, donc le modèle du bot reprend la main plutôt que de
 * laisser le run sans modèle du tout.
 */
export function applyRuntimeModelSelection(
  bot: { model: string | null; reasoningEffort: string | null },
  runtime: { provider: string | null; model: string | null; reasoningEffort: string | null },
  assignmentMode: ModelAssignmentMode = "per_bot",
): { provider: string | null; model: string | null; reasoningEffort: string | null } {
  const runtimeModel = runtime.model?.trim() || null;
  if (assignmentMode === "global" && runtimeModel) {
    return {
      model: runtimeModel,
      provider: runtime.provider?.trim() || null,
      reasoningEffort: runtime.reasoningEffort?.trim() || null,
    };
  }
  const explicitModel = bot.model?.trim() || null;
  return {
    model: explicitModel ?? runtimeModel,
    provider: explicitModel ? null : runtime.provider?.trim() || null,
    reasoningEffort: bot.reasoningEffort?.trim() || runtime.reasoningEffort?.trim() || null,
  };
}

export type ResolvedRunSelection = {
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
};

/**
export { NO_USABLE_PROVIDER_CODE, NO_USABLE_PROVIDER_MESSAGE };

/**
 * Résout une sélection explicitement exécutable avant de créer un run Hermes,
 * pour ne jamais laisser Hermes retomber sur son modèle par défaut (qui peut
 * pointer un fournisseur non authentifié → « HTTP 401 » opaque dans le fil).
 *
 * Ordre : sélection stockée si le catalogue la valide ; sinon le fournisseur
 * courant du runtime + son modèle par défaut ; sinon le premier fournisseur
 * authentifié qui liste au moins un modèle (hors agrégat « moa ») ; sinon null
 * : le run doit alors échouer avec HERMES_NO_USABLE_PROVIDER sans appeler Hermes.
 *
 * An explicit provider that lost its login, or vanished from the catalogue,
 * never reaches this order for a new run: `chosenProviderAuthRequired` fails
 * it first with `PROVIDER_AUTH_REQUIRED`.
 */
export function resolveRunnableSelection(
  catalog: HermesModelOptions,
  selection: ResolvedRunSelection,
  incidents: ReadonlyArray<{ provider: string; until: Date | string; kind?: "quota" | "auth" }> = [],
  preferred: { provider: string | null; model: string | null } = { provider: null, model: null },
): ResolvedRunSelection | null {
  const now = Date.now();
  // An `auth` incident never moves a run to another provider: the run tries
  // its own provider and fails with `PROVIDER_AUTH_REQUIRED`, so a login
  // repaired on the host is picked up at once and a dead one is named
  // instead of being silently served by someone else. Only a quota, which
  // clears on its own, routes around the provider.
  const blocked = new Set(
    incidents
      .filter((incident) => incident.kind !== "auth" && new Date(incident.until).getTime() > now)
      .map((incident) => incident.provider),
  );
  const authenticated = catalog.providers.filter((provider) => provider.authenticated);
  const runnable = authenticated.filter((provider) =>
    !blocked.has(provider.slug) && !isVirtualAggregateProvider(provider.slug),
  );
  const resolved = (provider: string | null, model: HermesModelOption): ResolvedRunSelection => ({
    provider,
    model: model.id,
    // L’effort de raisonnement n’est conservé que si le modèle résolu raisonne.
    reasoningEffort: model.reasoning ? selection.reasoningEffort : null,
  });

  if (selection.model) {
    if (selection.provider) {
      const provider = runnable.find((candidate) => candidate.slug === selection.provider)
        ?? (blocked.has(selection.provider) ? undefined : authenticated.find((candidate) => candidate.slug === selection.provider));
      const model = provider?.models.find((candidate) => candidate.id === selection.model);
      if (provider && model && !blocked.has(provider.slug)) return resolved(provider.slug, model);
    } else {
      // A profile's provider is the persisted choice when the bot stores only
      // a model id. Keep it ahead of another provider listing that same id.
      for (const slug of [catalog.provider, preferred.provider]) {
        const provider = runnable.find((candidate) => candidate.slug === slug);
        const model = provider?.models.find((candidate) => candidate.id === selection.model);
        if (provider && model) return resolved(provider.slug, model);
      }
      // Cas bot.model : le fournisseur est résolu ICI, vers celui qui est
      // AUTHENTIFIÉ et liste le modèle. Le laisser implicite (« Hermes routera
      // lui-même ») faisait router Hermes vers un fournisseur mal authentifié
      // quand le même id est listé par plusieurs (openai-codex OAuth ET
      // openai-api) → « HTTP 401: Missing Authentication header » dans le fil.
      for (const provider of runnable) {
        const model = provider.models.find((candidate) => candidate.id === selection.model);
        if (model) return resolved(provider.slug, model);
      }
    }
  }

  // Repli : le fournisseur courant du runtime avec son modèle par défaut.
  if (catalog.provider && catalog.model) {
    const current = runnable.find((candidate) => candidate.slug === catalog.provider);
    const model = current?.models.find((candidate) => candidate.id === catalog.model);
    if (current && model) return resolved(current.slug, model);
  }
  // Sinon la sélection du runtime dans openedbot, si son fournisseur est utilisable :
  // mesuré le 04-09, le premier modèle d'un fournisseur gratuit n'est pas
  // forcément servi (`x-preview-f-free` → « Model … is not supported »).
  if (preferred.provider) {
    const wanted = runnable.find((candidate) => candidate.slug === preferred.provider);
    const model = wanted?.models.find((candidate) => candidate.id === preferred.model)
      ?? (wanted && defaultTierModel(wanted.models))
      ?? wanted?.models[0];
    if (wanted && model) return resolved(wanted.slug, model);
  }
  // Sinon, le premier fournisseur authentifié qui a au moins un modèle.
  for (const provider of runnable) {
    const model = defaultTierModel(provider.models) ?? provider.models[0];
    if (model) return resolved(provider.slug, model);
  }
  return null;
}

/**
 * The provider chosen for this run when the catalogue says its login is gone.
 *
 * `resolveRunnableSelection` only keeps authenticated providers, so a chosen
 * provider that lost its login (removed, or a pool the host no longer reports
 * as logged in) used to fall through to the runtime's provider or the first
 * runnable one: the run was served by someone else with no
 * `run.provider_fallback` event, and the header kept naming the configured
 * model. Same invariant as the create path: an authentication failure of the
 * chosen provider is never served by another provider. The run fails with
 * `PROVIDER_AUTH_REQUIRED` instead, naming the provider to reconnect.
 *
 * A chosen provider that is no longer in the catalogue at all counts too:
 * upstream's `/api/model/options` lists authenticated providers only
 * (`hermes_cli/inventory.py`, `build_model_options_payload`), so a provider
 * whose login was removed usually vanishes rather than reading
 * `authenticated: false`. Resolution would otherwise serve the run on the
 * runtime's provider or the first runnable one, silently, with no
 * `run.provider_fallback` event. Like a refused login, a vanished provider
 * does not come back on its own: the operator reconnects it (or picks
 * another model), so it fails the same way rather than falling back.
 *
 * Only an explicit provider counts: a model-only choice (`per_bot`) leaves the
 * provider to the resolution, which picks one that serves the model. A quota
 * incident still routes around the provider (it clears on its own, and a
 * rate-limited pool stays listed upstream), and a virtual aggregate has no
 * login to reconnect.
 */
export function chosenProviderAuthRequired(
  catalog: HermesModelOptions,
  selection: ResolvedRunSelection,
  incidents: ReadonlyArray<{ provider: string; until: Date | string; kind?: "quota" | "auth" }> = [],
): string | null {
  const chosen = selection.model ? selection.provider?.trim() || null : null;
  if (!chosen || isVirtualAggregateProvider(chosen)) return null;
  const entry = catalog.providers.find((provider) => provider.slug === chosen);
  if (entry?.authenticated) return null;
  const now = Date.now();
  const quotaBlocked = incidents.some((incident) =>
    incident.provider === chosen && incident.kind !== "auth" && new Date(incident.until).getTime() > now,
  );
  return quotaBlocked ? null : chosen;
}

/**
 * Le modèle envoyé à Hermes est écrit sur le run au passage `creating`,
 * pas relu plus tard depuis le bot : un changement de préférence ne
 * réécrit pas l’historique.
 */
export async function persistResolvedRunModel(
  db: SQL,
  config: Pick<WorkerConfig, "workerId">,
  context: Pick<RunContext, "id" | "organizationId" | "leaseGeneration">,
  model: string | null,
): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    update runs set model = ${model}, external_state = 'creating', events_complete = false, updated_at = now()
     where id = ${context.id} and organization_id = ${context.organizationId}
       and lease_owner = ${config.workerId} and lease_generation = ${context.leaseGeneration}
       and status = 'starting' and external_state = 'not_started'
     returning id
  `;
  return Boolean(rows[0]);
}

export function fallbackAwareError(error: unknown, retryState: ProviderRetryState): unknown {
  if (!retryState.fallback) return error;
  const original = error instanceof Error ? error.message : String(error);
  const message = fallbackFailureMessage(original, retryState.fallback);
  if (error instanceof HermesClientError) {
    return new HermesClientError(message, error.status, error.code, {
      requestDelivery: error.requestDelivery ?? undefined,
      retryAfterMs: error.retryAfterMs ?? undefined,
      diagnostic: error.diagnostic ?? undefined,
      reference: error.reference ?? undefined,
    });
  }
  if (error instanceof NamedRunError) return new NamedRunError(error.code, message, error.details);
  return new NamedRunError("HERMES_RUN_FAILED", message);
}

/**
 * What the runner does after a provider failure.
 *
 * `retry` carries the sequence of the `run.provider_fallback` event it just
 * wrote (null if the lease was lost before): a run whose normaliser is
 * already open must skip it, or its next event proposes the same sequence,
 * refused since S2c (`RUN_EVENT_SEQUENCE_CONFLICT`); it used to be dropped by
 * `on conflict do nothing` (measured 2026-10-24: the first characters of every
 * answer after a fallback, "ello" for "hello"). `auth_required` names the provider whose
 * login was refused: the run fails with `PROVIDER_AUTH_REQUIRED`.
 */
export type ProviderRecovery =
  | { action: "retry"; selection: ResolvedRunSelection; state: ProviderRetryState; fallbackSequence: number | null }
  | { action: "auth_required"; provider: string }
  | { action: "give_up" };

export async function recoverProviderFailure(
  db: SQL,
  config: WorkerConfig,
  client: HermesClient,
  context: RunContext,
  error: unknown,
  selection: ResolvedRunSelection,
  retryState: ProviderRetryState,
): Promise<ProviderRecovery> {
  const catalog = await client.modelOptions().catch(() => null);
  const incidents = await loadActiveIncidents(db, context.organizationId, context.runtimeId);
  const plan = planProviderRetry(error, selection, catalog, incidents, retryState, {
    runtimeSelectedProvider: context.runtimeSelectedProvider,
    runtimeSelectedModel: context.runtimeSelectedModel,
  });
  const fallback = plan.action === "retry" ? plan.state.fallback : null;
  const failedProvider = servingProvider(
    catalog,
    context.hermesProfile,
    selection.provider ?? retryState.fromProvider,
  );
  // Sans repli, la panne s'enregistre quand même : quand tous les fournisseurs
  // sont morts, l'incident est le seul signal qui passe l'affichage en KO.
  if (plan.kind === "quota" || plan.kind === "auth") {
    // L'erreur d'un run arrive en trame SSE : un objet, dont le diagnostic vit
    // dans `message` / `error` (voir `describe`).
    const message = describe(error).slice(0, 500);
    if (failedProvider) {
      await recordProviderIncident(db, {
        organizationId: context.organizationId,
        runtimeId: context.runtimeId,
        provider: failedProvider,
        kind: plan.kind,
        runId: context.id,
        message,
        fallbackProvider: fallback?.provider ?? null,
        fallbackModel: fallback?.model ?? null,
      });
    }
    if (failedProvider) {
      await enqueueQuotaReachedEmail(db, {
        organizationId: context.organizationId,
        runtimeId: context.runtimeId,
        provider: failedProvider,
        kind: plan.kind,
        occurredAt: new Date(),
        fallbackProvider: fallback?.provider ?? null,
        fallbackModel: fallback?.model ?? null,
        settingsUrl: `${config.webAppUrl}/settings/models`,
        webAppUrl: config.webAppUrl,
      }).catch((emailError) => {
        log("worker.provider_quota_email_failed", { runId: context.id, error: describe(emailError) });
      });
    }
  }
  if (plan.kind === "auth" && failedProvider) {
    log("worker.provider_auth_required", { runId: context.id, organizationId: context.organizationId, provider: failedProvider });
    return { action: "auth_required", provider: failedProvider };
  }
  if (plan.action !== "retry" || !plan.selection.provider || !plan.selection.model || !fallback) return { action: "give_up" };
  // Le repli n'existe que si le profil le porte : sans cette écriture le
  // prochain `createRun` repart sur le fournisseur du profil et rejoue la même
  // panne, une fois par tentative.
  const applied = await applyFallbackProfileModel(
    client,
    context.hermesProfile,
    context,
    { provider: fallback.provider, model: fallback.model },
  );
  if (context.hermesProfile && !applied) {
    log("worker.profile_model_not_applied", {
      runId: context.id,
      profile: context.hermesProfile,
      provider: fallback.provider,
      model: fallback.model,
      capability: context.linkFeatures.includes(PROFILE_MANAGEMENT_FEATURE),
    });
    // Le repli repartirait chez le fournisseur du profil, celui qui vient
    // d'échouer : pas de nouvelle tentative sous une étiquette fausse.
    if (profileServesOtherProvider(catalog, fallback.provider)) return { action: "give_up" };
  }
  const committed = await persistUnnumberedEvents(db, config, context, context.lastHermesSequence, [{
    type: PROVIDER_FALLBACK_EVENT,
    occurredAt: new Date(),
    payload: providerFallbackPayload(plan.state.fromProvider, fallback),
  }]);
  log("worker.provider_fallback", {
    runId: context.id,
    organizationId: context.organizationId,
    from: plan.state.fromProvider,
    to: fallback.provider,
    model: fallback.model,
    reason: fallback.reason,
    profileApplied: applied,
  });
  // Null when the lease was lost meanwhile: the next write of this run is refused anyway.
  const fallbackSequence = committed.find((event) => event.type === PROVIDER_FALLBACK_EVENT)?.sequence ?? null;
  return { action: "retry", selection: plan.selection, state: plan.state, fallbackSequence };
}

/**
 * Le profil multiplexé route sur un AUTRE fournisseur que celui demandé : tant
 * que son bloc `model` n'est pas réécrit, le prompt partirait chez lui. Un bloc
 * vide ou un catalogue illisible ne prouve pas l'écart.
 */
export function profileServesOtherProvider(
  catalog: { provider: string | null } | null,
  requestedProvider: string,
): boolean {
  const current = catalog?.provider?.trim();
  return Boolean(current) && current !== requestedProvider;
}

/** The error a new run fails with when its model could not be set on its profile. */
export function profileModelNotAppliedError(provider: string, model: string): NamedRunError {
  return new NamedRunError(
    "PROFILE_MODEL_NOT_APPLIED",
    "Le modèle choisi n’a pas pu être appliqué au profil Hermes de ce bot : le run n’a pas été lancé, pour ne pas répondre avec un autre fournisseur. Réessayez dans un instant.",
    { provider, model },
  );
}

/** The error a run fails with when its provider refused the bot's login. */
export function providerAuthRequiredError(provider: string): NamedRunError {
  const payload = providerAuthRequiredPayload(provider);
  return new NamedRunError(payload.errorCode, payload.message, { provider });
}

/**
 * Un seul appel catalogue par executeRun, et uniquement pour un run neuf.
 *
 * Catalogue injoignable : un incident réseau transitoire ne doit pas bloquer un
 * run qui sait déjà quel modèle il veut, donc la sélection stockée part telle
 * quelle et Hermes tranche. Mais SANS modèle stocké il n'y a rien à envoyer, et
 * `stored` est un objet toujours truthy : le garde `if (!selection)` passait,
 * les champs étaient omis, et Hermes retombait sur son défaut : d'où sa consigne
 * CLI (« Run 'hermes model' ») dans le fil au lieu de notre phrase produit.
 */
export async function resolveSelectionForNewRun(
  db: SQL,
  client: HermesClient,
  context: RunContext,
  /** The same catalogue read, already started with the preflight inventory. */
  prefetchedCatalog: Promise<HermesModelOptions | null> | null = null,
  /** Present only for a new run. A stable resolution is remembered for the warm path. */
  warmKey: string | null = null,
): Promise<ResolvedRunSelection | null> {
  const stored: ResolvedRunSelection = {
    provider: context.provider,
    model: context.model,
    reasoningEffort: context.reasoningEffort,
  };
  const catalog = await (prefetchedCatalog ?? client.modelOptions().catch(() => null));
  if (profileCatalogMissingCurrent(catalog, stored, context.hermesProfile)) {
    log("worker.profile_model_unset", {
      runId: context.id,
      profile: context.hermesProfile,
      selectedProvider: stored.provider,
      selectedModel: stored.model,
    });
  }
  if (!catalog) return stored.model ? stored : null;
  const incidents = await loadActiveIncidents(db, context.organizationId, context.runtimeId);
  const authRequired = chosenProviderAuthRequired(catalog, stored, incidents);
  if (authRequired) {
    log("worker.provider_auth_required", {
      runId: context.id,
      organizationId: context.organizationId,
      provider: authRequired,
      stage: "selection",
    });
    throw providerAuthRequiredError(authRequired);
  }
  const resolved = resolveRunnableSelection(catalog, stored, incidents, {
    provider: context.runtimeSelectedProvider,
    model: context.runtimeSelectedModel,
  });
  // Mesuré le 04-09 : sous `/p/<slug>` le gateway lit `model.provider` dans la
  // config du profil, pas le `provider` du run. La comparaison porte donc sur le
  // bloc EFFECTIF du profil, que ce même catalogue relit (`catalog.provider` /
  // `catalog.model` sous `/p/<slug>`), et non sur la sélection stockée : comparer
  // à la sélection réécrivait le profil à chaque run même quand il était déjà
  // juste, pour une mutation hôte qui tient une minute au pire.
  if (
    resolved?.model
    && !profileModelWriteNeeded(catalog, resolved, context.hermesProfile)
  ) {
    rememberWarmModelSelection(warmKey, resolved, Date.now());
  }
  if (resolved?.provider && resolved.model && profileModelWriteNeeded(catalog, resolved, context.hermesProfile)) {
    const selection = { provider: resolved.provider, model: resolved.model };
    const applied = await applyFallbackProfileModel(client, context.hermesProfile, context, selection);
    if (!applied) {
      log("worker.profile_model_not_applied", {
        runId: context.id,
        profile: context.hermesProfile,
        provider: selection.provider,
        model: selection.model,
        profileProvider: catalog.provider,
        profileModel: catalog.model,
        capability: context.linkFeatures.includes(PROFILE_MANAGEMENT_FEATURE),
      });
      // Le gateway route sur le fournisseur du profil, pas sur celui du corps
      // du run : lancer quand même afficherait le modèle demandé pendant qu'un
      // autre fournisseur répond.
      if (profileServesOtherProvider(catalog, selection.provider)) {
        throw profileModelNotAppliedError(selection.provider, selection.model);
      }
    }
  }
  return resolved;
}

/**
 * Le fournisseur qui a RÉELLEMENT servi le run, à qui un incident s'impute.
 *
 * Sous un profil multiplexé le gateway route sur le bloc `model` du profil et
 * ignore le `provider` du corps du run : le fournisseur demandé n'est alors pas
 * celui qui a échoué. Mesuré le 10-09 : profil cloué sur `openai-codex`, quota
 * Codex épuisé, et openedbot bannissait `xai-oauth` six heures : le fournisseur que
 * l'opérateur venait justement de choisir, et qui allait bien.
 *
 * Le bloc du profil est relu dans le catalogue du run (`/p/<slug>/api/model/options`).
 * Bloc vide ou catalogue illisible : on retombe sur le fournisseur demandé,
 * faute de mieux.
 */
export function servingProvider(
  catalog: { provider: string | null } | null,
  hermesProfile: string | null,
  requested: string | null,
): string | null {
  if (!hermesProfile) return requested;
  return catalog?.provider?.trim() || requested;
}

/**
 * Le bloc `model` du profil doit-il être réécrit avant ce run.
 *
 * Vrai seulement quand un profil est en jeu, que la résolution nomme un couple
 * complet, et que ce couple s'écarte de celui que le gateway lit aujourd'hui.
 * Un bloc profil encore vide compte comme un écart : le gateway retomberait
 * sinon sur son défaut.
 */
export function profileModelWriteNeeded(
  catalog: { provider: string | null; model: string | null } | null,
  resolved: { provider: string | null; model: string | null } | null,
  hermesProfile: string | null,
): boolean {
  if (!hermesProfile || !catalog) return false;
  if (!resolved?.provider || !resolved.model) return false;
  return resolved.provider !== catalog.provider?.trim() || resolved.model !== catalog.model?.trim();
}

/**
 * Catalogue relu sous `/p/<slug>/api/model/options` : `current_provider` /
 * `current_model` (champs `provider` / `model`) nuls alors qu'une sélection
 * est posée. Le multiplexage ignore alors le `provider` du run.
 */
export function profileCatalogMissingCurrent(
  catalog: { provider: string | null; model: string | null } | null,
  selection: { provider: string | null; model: string | null },
  hermesProfile: string | null,
): boolean {
  if (!hermesProfile || !catalog) return false;
  const posed = Boolean(selection.provider?.trim() || selection.model?.trim());
  if (!posed) return false;
  return !catalog.provider?.trim() && !catalog.model?.trim();
}

/**
 * Échec avant même l’appel à Hermes : aucun fournisseur utilisable. On passe
 * par persistUnnumberedEvents pour que le message remonte dans le fil exactement comme
 * un run.error Hermes, sans jamais repasser par la file de retry.
 */
export async function failWithoutUsableProvider(db: SQL, config: WorkerConfig, context: RunContext): Promise<void> {
  await persistUnnumberedEvents(db, config, context, context.lastHermesSequence, [{
    type: "run.error",
    occurredAt: new Date(),
    payload: { message: NO_USABLE_PROVIDER_MESSAGE, errorCode: NO_USABLE_PROVIDER_CODE },
  }]);
  log("worker.run_failed", {
    runId: context.id,
    organizationId: context.organizationId,
    code: NO_USABLE_PROVIDER_CODE,
    error: NO_USABLE_PROVIDER_MESSAGE,
  });
}
