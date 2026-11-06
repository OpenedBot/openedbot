import { DEFAULT_LOCALE } from "@openedbot/contracts-locale";
import { PROVIDER_AUTH_REQUIRED_CODE } from "@openedbot/contracts-errors";
import type { SQL } from "bun";
import type { HermesClient, HermesModelOption, HermesModelOptions, HermesModelProvider } from "@openedbot/hermes";
import {
  classifyProviderFailure,
  isVirtualAggregateProvider,
  providerIncidentTtlHours,
  type ProviderFailureKind,
} from "../domain/provider-failure";
import { withTenant } from "@openedbot/platform-db";
import { enqueueEmailReturningId } from "@openedbot/notifications/sql/email-outbox";
import { invalidateProvenRuntimeModels } from "@openedbot/runtimes/sql/model-selection-proofs";
import { defaultTierModel } from "@openedbot/runtimes/domain/runtime/default-model";
import { RELAY_FEATURE_PROFILE_MANAGEMENT } from "@openedbot/contracts-connector/features";
export type RunModelSelection = {
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
};

export const PROVIDER_FALLBACK_EVENT = "run.provider_fallback" as const;
export const PROVIDER_QUOTA_EMAIL_KIND = "provider_quota_reached" as const;

export type ActiveProviderIncident = {
  provider: string;
  kind: "quota" | "auth";
  until: Date;
};

export type FallbackCandidate = {
  provider: string;
  model: string;
  reason: ProviderFailureKind;
  /** Le modèle de repli raisonne : seul lui accepte un effort de raisonnement. */
  reasoning: boolean;
};

export type FallbackSelectionOptions = {
  /** Fournisseur qui vient d'échouer : jamais repris comme repli de ce run. */
  excludedProvider: string | null;
  /** Modèle déjà tenté sur le fournisseur de repli (`model_unsupported`). */
  excludedModel?: string | null;
  /** Sélection openedbot du runtime (un couple), si elle cible le fournisseur retenu. */
  runtimeSelectedProvider: string | null;
  runtimeSelectedModel: string | null;
  now?: Date;
};

function isIncidentActive(
  incident: { until: Date | string },
  now: Date = new Date(),
): boolean {
  return new Date(incident.until).getTime() > now.getTime();
}

function activeIncidentProviders(
  incidents: ReadonlyArray<ActiveProviderIncident>,
  now: Date = new Date(),
): Set<string> {
  return new Set(
    incidents.filter((incident) => isIncidentActive(incident, now)).map((incident) => incident.provider),
  );
}

function providerUsable(
  provider: HermesModelProvider,
  blocked: ReadonlySet<string>,
): boolean {
  return provider.authenticated
    && !isVirtualAggregateProvider(provider.slug)
    && !blocked.has(provider.slug)
    && provider.models.length > 0;
}

function preferredModel(
  provider: HermesModelProvider,
  catalog: HermesModelOptions,
  options: FallbackSelectionOptions,
): HermesModelOption | null {
  const runtimeMatch = options.runtimeSelectedProvider === provider.slug
    && options.runtimeSelectedModel
    && provider.models.find((model) => model.id === options.runtimeSelectedModel);
  if (runtimeMatch) return runtimeMatch;
  if (catalog.provider === provider.slug && catalog.model) {
    const current = provider.models.find((model) => model.id === catalog.model);
    if (current) return current;
  }
  return defaultTierModel(provider.models) ?? provider.models[0] ?? null;
}

/**
 * Ordre de repli : la sélection de l'opérateur d'abord, puis le gratuit, puis le
 * fournisseur courant de l'hôte.
 *
 * « Gratuit d'abord » seul ne tient pas : `authenticated` et une liste de
 * modèles non vide ne prouvent aucune inférence. Mesuré le 10-09 sur
 * `opencode-free`, authentifié et annonçant six modèles, dont chacun répond
 * « HTTP 401: Model … is not supported » : le repli y dépensait ses deux
 * tentatives et abandonnait, alors que le `xai-oauth` choisi par l'opérateur
 * répondait. Un fournisseur que l'opérateur a posé lui-même est un choix
 * explicite, avec un quota qu'il connaît : il passe devant une gratuité
 * théorique.
 */
function rankProviders(
  providers: HermesModelProvider[],
  currentProvider: string | null,
  selectedProvider: string | null,
): HermesModelProvider[] {
  const rank = (provider: HermesModelProvider): number => {
    if (selectedProvider && provider.slug === selectedProvider) return 0;
    if (provider.slug.endsWith("-free")) return 1;
    if (provider.slug === currentProvider) return 2;
    return 3;
  };
  return [...providers].sort((left, right) => rank(left) - rank(right));
}

/**
 * Choisit un repli : authentifié, non virtuel, hors incident, avec des modèles.
 * Ordre : la sélection du runtime, puis les slugs `*-free`, puis le fournisseur
 * courant de l'hôte (voir `rankProviders`).
 */
export function selectFallbackSelection(
  catalog: HermesModelOptions,
  incidents: ReadonlyArray<ActiveProviderIncident>,
  options: FallbackSelectionOptions,
): FallbackCandidate | null {
  const now = options.now ?? new Date();
  const blocked = activeIncidentProviders(incidents, now);
  if (options.excludedProvider) blocked.add(options.excludedProvider);
  const usable = catalog.providers.filter((provider) => providerUsable(provider, blocked));
  for (const provider of rankProviders(usable, catalog.provider, options.runtimeSelectedProvider)) {
    const model = preferredModel(provider, catalog, options);
    if (!model) continue;
    if (options.excludedModel && model.id === options.excludedModel) continue;
    return { provider: provider.slug, model: model.id, reason: "quota", reasoning: model.reasoning };
  }
  return null;
}

/**
 * Après un `model_unsupported` sur le repli : le modèle suivant du même
 * fournisseur, une seule fois. Jamais un autre fournisseur ici.
 */
export function selectNextModelOnProvider(
  catalog: HermesModelOptions,
  providerSlug: string,
  triedModel: string,
): FallbackCandidate | null {
  const provider = catalog.providers.find((candidate) => candidate.slug === providerSlug);
  if (!provider || isVirtualAggregateProvider(provider.slug) || !provider.authenticated) return null;
  const next = provider.models.find((model) => model.id !== triedModel);
  if (!next) return null;
  return { provider: provider.slug, model: next.id, reason: "model_unsupported", reasoning: next.reasoning };
}

export type ProviderRetryState = {
  fallbackAttempted: boolean;
  extraModelTried: boolean;
  fromProvider: string | null;
  fallback: FallbackCandidate | null;
};

export type ProviderRetryPlan =
  | { action: "retry"; selection: RunModelSelection; state: ProviderRetryState; kind: "quota" | "model_unsupported" }
  | { action: "give_up"; kind: ProviderFailureKind };

/**
 * L'effort de raisonnement ne survit à un repli que si le modèle d'arrivée
 * raisonne.
 *
 * C'est la règle que tiennent déjà `resolveRunnableSelection` (worker) et
 * `catalogValidatedSelection` (API) : `model_options.reasoning_effort` ne part
 * chez Hermes que pour un modèle qui l'accepte. Le repli, lui, recopiait
 * l'effort du modèle de départ : un run passé d'un modèle raisonnant à un
 * modèle qui ne raisonne pas emportait un effort que personne n'avait choisi
 * pour lui, et que le catalogue déclare pourtant inapplicable.
 */
function effortAfterFallback(
  requested: string | null,
  candidate: FallbackCandidate,
): string | null {
  return candidate.reasoning ? requested : null;
}

/**
 * Un run : un repli fournisseur, plus un essai du modèle suivant si
 * `model_unsupported`. Pas de troisième chance.
 *
 * Only a transient refusal (quota, rate limit) is re-routed. An
 * authentication failure of the provider chosen for the bot is never
 * silently served by another provider (operator decision, 2026-10-24: an
 * expired xAI login was answered by Anthropic, the header still said
 * grok, and every later run did the same). The run fails with
 * `PROVIDER_AUTH_REQUIRED`, which tells the operator which provider to
 * reconnect.
 */
export function planProviderRetry(
  error: unknown,
  selection: RunModelSelection,
  catalog: HermesModelOptions | null,
  incidents: ReadonlyArray<ActiveProviderIncident>,
  state: ProviderRetryState,
  options: Omit<FallbackSelectionOptions, "excludedProvider" | "excludedModel">,
): ProviderRetryPlan {
  const kind = classifyProviderFailure(error);
  if (!catalog) return { action: "give_up", kind };
  if (kind === "quota" && !state.fallbackAttempted) {
    const fallback = selectFallbackSelection(catalog, incidents, {
      ...options,
      excludedProvider: selection.provider,
    });
    if (!fallback) return { action: "give_up", kind };
    fallback.reason = kind;
    return {
      action: "retry",
      kind,
      selection: {
        provider: fallback.provider,
        model: fallback.model,
        reasoningEffort: effortAfterFallback(selection.reasoningEffort, fallback),
      },
      state: {
        fallbackAttempted: true,
        extraModelTried: false,
        fromProvider: selection.provider,
        fallback,
      },
    };
  }
  if (kind === "model_unsupported" && state.fallbackAttempted && !state.extraModelTried && state.fallback) {
    const next = selectNextModelOnProvider(catalog, state.fallback.provider, state.fallback.model);
    if (!next) return { action: "give_up", kind };
    return {
      action: "retry",
      kind,
      selection: {
        provider: next.provider,
        model: next.model,
        reasoningEffort: effortAfterFallback(selection.reasoningEffort, next),
      },
      state: {
        ...state,
        extraModelTried: true,
        fallback: next,
      },
    };
  }
  return { action: "give_up", kind };
}

export type RecordedIncident = {
  provider: string;
  kind: "quota" | "auth";
  until: Date;
  fallbackProvider: string | null;
  fallbackModel: string | null;
};

export async function loadActiveIncidents(
  db: SQL,
  organizationId: string,
  runtimeId: string,
  now: Date = new Date(),
): Promise<ActiveProviderIncident[]> {
  const rows = await withTenant(db, organizationId, (tx) => tx<Array<{ provider: string; kind: "quota" | "auth"; until: Date | string }>>`
    select provider, kind, until from runtime_provider_incidents
     where organization_id = ${organizationId} and runtime_id = ${runtimeId}
       and until > ${now}
  `);
  return rows.map((row) => ({
    provider: row.provider,
    kind: row.kind,
    until: new Date(row.until),
  }));
}

export async function recordProviderIncident(
  db: SQL,
  input: {
    organizationId: string;
    runtimeId: string;
    provider: string;
    kind: "quota" | "auth";
    runId: string;
    message: string | null;
    fallbackProvider: string | null;
    fallbackModel: string | null;
    now?: Date;
  },
): Promise<RecordedIncident> {
  const now = input.now ?? new Date();
  const hours = providerIncidentTtlHours(input.kind);
  const until = new Date(now.getTime() + hours * 3_600_000);
  const message = input.message?.slice(0, 500) ?? null;
  await withTenant(db, input.organizationId, async (tx) => {
    await tx`
      insert into runtime_provider_incidents (
        organization_id, runtime_id, provider, kind, first_seen_at, last_seen_at, until,
        fallback_provider, fallback_model, run_id, message
      ) values (
        ${input.organizationId}, ${input.runtimeId}, ${input.provider}, ${input.kind},
        ${now}, ${now}, ${until},
        ${input.fallbackProvider}, ${input.fallbackModel}, ${input.runId}, ${message}
      )
      on conflict (organization_id, runtime_id, provider) do update
        set kind = excluded.kind,
            last_seen_at = excluded.last_seen_at,
            until = excluded.until,
            fallback_provider = excluded.fallback_provider,
            fallback_model = excluded.fallback_model,
            run_id = excluded.run_id,
            message = excluded.message
    `;
    await invalidateProvenRuntimeModels(tx, input.organizationId, input.runtimeId, input.provider);
  });
  return {
    provider: input.provider,
    kind: input.kind,
    until,
    fallbackProvider: input.fallbackProvider,
    fallbackModel: input.fallbackModel,
  };
}

export async function clearProviderIncident(
  db: SQL,
  organizationId: string,
  runtimeId: string,
  provider: string,
): Promise<void> {
  await withTenant(db, organizationId, (tx) => tx`
    delete from runtime_provider_incidents
     where organization_id = ${organizationId} and runtime_id = ${runtimeId} and provider = ${provider}
  `);
}

export function fallbackIdempotencyKey(runId: string, extraModel: boolean): string {
  return extraModel ? `${runId}:fallback2` : `${runId}:fallback`;
}

export function fallbackFailureMessage(original: string, fallback: FallbackCandidate | null): string {
  if (!fallback) return original;
  return `${original} Repli tenté sur ${fallback.provider} / ${fallback.model}.`;
}

/**
 * Le message d'un run que Hermes déclare échoué APRÈS un repli. Sans lui, la
 * réconciliation écrivait « Le run Hermes a échoué. » et l'opérateur ne
 * voyait jamais que le premier fournisseur avait refusé l'authentification
 * du bot (2026-10-17 : profil neuf, openai-codex en `auth`, repli
 * opencode-free sans réponse). `fallback` est la charge de
 * `run.provider_fallback` ; absente, le message générique reste.
 */
export function reconciledFailureMessage(fallback: Record<string, unknown> | null | undefined): string {
  const generic = "Le run Hermes a échoué.";
  if (!fallback) return generic;
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const from = text(fallback.from) ?? "le fournisseur du bot";
  const to = text(fallback.to);
  const model = text(fallback.model);
  const target = to ? (model ? `${to} / ${model}` : to) : null;
  const tail = target ? `, puis le repli sur ${target} n’a pas abouti.` : ".";
  switch (fallback.reason) {
    case "auth":
      return `Le run Hermes a échoué : ${from} a refusé l’authentification de ce bot${tail}`;
    case "quota":
      return `Le run Hermes a échoué : ${from} a atteint sa limite d’usage${tail}`;
    case "model_unsupported":
      return `Le run Hermes a échoué : ${from} ne sert pas ce modèle${tail}`;
    default:
      return target ? `Le run Hermes a échoué après un repli sur ${target}.` : generic;
  }
}

/**
 * The `run.error` payload of a run whose chosen provider refused its
 * authentication. `provider` lets the console name it and link to the
 * Models settings; `message` is the readable fallback for older clients.
 */
export function providerAuthRequiredPayload(provider: string): { message: string; errorCode: string; provider: string } {
  return {
    message: `${provider} a refusé l’authentification de ce bot. Reconnectez ${provider} dans Réglages → Modèles.`,
    errorCode: PROVIDER_AUTH_REQUIRED_CODE,
    provider,
  };
}

export function providerFallbackPayload(
  from: string | null,
  fallback: FallbackCandidate,
): Record<string, unknown> {
  return {
    from: from,
    to: fallback.provider,
    model: fallback.model,
    reason: fallback.reason,
    message: from
      ? `Repli : ${from} → ${fallback.provider} / ${fallback.model}`
      : `Repli : ${fallback.provider} / ${fallback.model}`,
  };
}

/**
 * Le bloc `model` du profil est la SEULE chose que le gateway lit pour router un
 * run multiplexé : sous `/p/<slug>` il ignore le `provider` du corps du run.
 * Tant que ce bloc n'est pas écrit, un choix de modèle openedbot (par bot, global, ou
 * un repli fournisseur) part dans le vide et le run reste sur le fournisseur du
 * profil : mesuré le 10-09 : profil cloué sur `openai-codex`, quota épuisé, et
 * chaque repli rejouait la même panne Codex.
 *
 * Le droit d'écrire ne vient donc pas de « openedbot possède ce profil »
 * (`hermes_profile_managed`, faux pour tout profil explicite ou importé) mais de
 * la capacité que l'hôte NOMME. Aucune capacité annoncée : aucune écriture, et
 * l'appelant l'apprend par `false` plutôt que par un succès supposé.
 */
export async function applyFallbackProfileModel(
  client: Pick<HermesClient, "hostSetProfileModel">,
  profile: string | null,
  capability: { linkFeatures: ReadonlyArray<string> },
  selection: { provider: string; model: string },
): Promise<boolean> {
  if (!profile || !capability.linkFeatures.includes(RELAY_FEATURE_PROFILE_MANAGEMENT)) return false;
  try {
    const result = await client.hostSetProfileModel(profile, selection);
    return result.applied;
  } catch {
    return false;
  }
}

export function quotaEmailDedupeKey(runtimeId: string, provider: string, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  return `provider-quota:${runtimeId}:${provider}:${day}`;
}

export async function enqueueQuotaReachedEmail(
  db: SQL,
  input: {
    organizationId: string;
    runtimeId: string;
    provider: string;
    /** `quota` (429) ou `auth` (login mort, « No inference provider configured ») : même alerte, sujet différent. */
    kind?: "quota" | "auth";
    occurredAt: Date;
    fallbackProvider: string | null;
    fallbackModel: string | null;
    settingsUrl: string;
    /** Origine de la PWA, pour les liens légaux du pied de page. */
    webAppUrl: string;
  },
): Promise<number> {
  const recipients = await db<Array<{ userId: string; email: string; organizationSlug?: string }>>`
    select u.id as "userId", u.email, o.slug as "organizationSlug"
      from memberships m
      join users u on u.id = m.user_id
      join organizations o on o.id = m.organization_id
     where m.organization_id = ${input.organizationId}
       and m.role in ('owner', 'admin') and m.revoked_at is null
       and u.email is not null
  `;
  const fallback = input.fallbackProvider && input.fallbackModel
    ? `${input.fallbackProvider} / ${input.fallbackModel}`
    : "aucun";
  const settingsUrl = new URL(input.settingsUrl);
  // The tenant URL segment is the slug; the console still resolves a legacy UUID.
  const workspace = recipients[0]?.organizationSlug ?? input.organizationId;
  settingsUrl.pathname = `/o/${encodeURIComponent(workspace)}${settingsUrl.pathname}`;
  const payload = {
    provider: input.provider,
    kind: input.kind ?? "quota",
    occurredAt: input.occurredAt.toISOString(),
    fallback,
    fallbackProvider: input.fallbackProvider,
    fallbackModel: input.fallbackModel,
    settingsUrl: settingsUrl.toString(),
    webAppUrl: input.webAppUrl,
  };
  let inserted = 0;
  for (const recipient of recipients) {
    const queued = await enqueueEmailReturningId(db, {
      kind: PROVIDER_QUOTA_EMAIL_KIND,
      dedupeKey: `${quotaEmailDedupeKey(input.runtimeId, input.provider, input.occurredAt)}:${recipient.userId}`,
      recipientEmail: recipient.email,
      locale: DEFAULT_LOCALE,
      payload,
    });
    if (queued) inserted += 1;
  }
  return inserted;
}
