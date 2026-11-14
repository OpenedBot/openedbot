import { defaultTierModel } from "@openedbot/runtimes/domain/runtime/default-model";
import { isVirtualAggregateProvider } from "./provider-failure";

/**
 * Pure: the worker resolves a new run's model with it, and the API with the
 * same rule says which model a bot with nothing chosen will run on, so the
 * console never names a model other than the one Hermes is asked for.
 */

/**
 * The part of a Hermes catalogue the resolution reads: `HermesModelOptions`
 * fits, and so does the API's catalogue dto, which no longer holds the raw one.
 */
export type RunSelectionCatalog = {
  provider: string | null;
  model: string | null;
  providers: ReadonlyArray<{
    slug: string;
    authenticated: boolean;
    models: ReadonlyArray<{ id: string; reasoning: boolean; fast?: boolean }>;
  }>;
};

export type ResolvedRunSelection = {
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  /**
   * The model's fast mode (`model_options.fast`). Kept only when the resolved
   * model is the one asked for and the catalogue marks it `fast`: it is
   * billed at a higher rate, so neither a fallback nor a model without it
   * inherits the wish. Absent means normal speed.
   */
  fastMode?: boolean;
};

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
  catalog: RunSelectionCatalog,
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
  const resolved = (provider: string | null, model: { id: string; reasoning: boolean; fast?: boolean }): ResolvedRunSelection => ({
    provider,
    model: model.id,
    // L’effort de raisonnement n’est conservé que si le modèle résolu raisonne.
    reasoningEffort: model.reasoning ? selection.reasoningEffort : null,
    ...(selection.fastMode === true && model.fast === true && model.id === selection.model ? { fastMode: true } : {}),
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
