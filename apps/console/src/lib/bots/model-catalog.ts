import type { RuntimeModelDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { isHermesReasoningEffort, type HermesReasoningEffort } from "@openedbot/contracts-api";
import { compareRelease } from "@openedbot/runtimes/domain/runtime/default-model";

export type ModelGroup = { slug: string; name: string; models: RuntimeModelDto[] };

export const FEATURED_PROVIDER_SLUGS = [
  "openai-codex",
  "openai-api",
  "anthropic",
  "gemini",
  "xai-oauth",
  "openrouter",
  "opencode-zen",
  "copilot",
  "deepseek",
] as const;

export type ProviderRailEntry = { slug: string; name: string; connected: boolean };

export type ModelCatalogView = {
  /** Displayable groups: authenticated providers, deduplicated models. */
  groups: ModelGroup[];
  /** Every id that can be offered: a choice outside this set will not be honored by the worker. */
  knownIds: Set<string>;
  /** The ids whose model reasons: only they accept an effort. */
  reasoningIds: Set<string>;
  /**
   * The ids whose model offers a fast mode (Hermes `capabilities.fast`): only
   * they show the switch, and the worker honours it only for them.
   */
  fastIds: Set<string>;
};

/** Two ids that differ only by `.` or `-` name the same model. */
function aliasKey(id: string): string {
  return id.toLowerCase().replaceAll(".", "-");
}

/**
 * Hermes sometimes lists a model under two ids (`claude-fable-5.1` and
 * `claude-fable-5-1`): only one is offered. The one `keep` names (the
 * saved choice, which must stay visible and selected) wins, otherwise
 * the first listed by Hermes. Both stay valid choices
 * (`knownIds`): only the display is deduplicated.
 */
export function withoutAliases<T extends { id: string }>(models: readonly T[], keep: Iterable<string | null> = []): T[] {
  const kept = new Set(keep);
  const chosen = new Map<string, T>();
  for (const model of models) {
    const current = chosen.get(aliasKey(model.id));
    if (!current || (kept.has(model.id) && !kept.has(current.id))) chosen.set(aliasKey(model.id), model);
  }
  return models.filter((model) => chosen.get(aliasKey(model.id)) === model);
}

/**
 * A provider's models from newest to oldest, according to the
 * version read in their id (`releaseKey`), with no alias duplicate
 * (`withoutAliases`). At equal version, Hermes's order is kept (stable
 * sort); ids with no version go to the end.
 */
export function modelsByRelease<T extends { id: string }>(models: readonly T[], keep: Iterable<string | null> = []): T[] {
  return withoutAliases(models, keep).sort((left, right) => compareRelease(left.id, right.id));
}

/**
 * The Hermes catalog's « picker » view, shared by Settings → Models
 * (« Par bot » tab) and a bot's modal.
 *
 * AUTHENTICATED providers only: that is the condition for
 * `resolveRunnableSelection` (worker) to honor the choice instead of falling back
 * silently to the runtime default. The same id can be listed by several
 * providers (codex AND openai-api): the saved value is the id alone and
 * Radix requires unique values, so each id appears only once, in
 * the first group that lists it.
 */
export function catalogModelView(
  providers: RuntimeModelProviderDto[],
  /** Ids already chosen (bot, global model): never hidden as an alias duplicate. */
  keep: Iterable<string | null> = [],
): ModelCatalogView {
  const kept = [...keep];
  const authenticated = providers.filter((provider) => provider.authenticated && provider.models.length > 0);
  const knownIds = new Set(authenticated.flatMap((provider) => provider.models.map((model) => model.id)));
  const reasoningIds = new Set(
    authenticated.flatMap((provider) => provider.models.filter((model) => model.reasoning).map((model) => model.id)),
  );
  const fastIds = new Set(
    authenticated.flatMap((provider) => provider.models.filter((model) => model.fast).map((model) => model.id)),
  );
  const seen = new Set<string>();
  const groups = authenticated
    .map((provider) => ({
      slug: provider.slug,
      name: provider.name,
      models: modelsByRelease(provider.models, kept).filter((model) => {
        if (seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      }),
    }))
    .filter((group) => group.models.length > 0);
  return { groups, knownIds, reasoningIds, fastIds };
}

export function providerRail(providers: RuntimeModelProviderDto[]): ProviderRailEntry[] {
  const groups = catalogModelView(providers).groups;
  const connectedSlugs = new Set(
    providers.filter((provider) => provider.authenticated && provider.models.length > 0).map((provider) => provider.slug),
  );
  const seen = new Set<string>();
  const entries: ProviderRailEntry[] = [];

  for (const group of groups) {
    if (seen.has(group.slug)) continue;
    seen.add(group.slug);
    entries.push({ slug: group.slug, name: group.name, connected: true });
  }

  for (const slug of FEATURED_PROVIDER_SLUGS) {
    if (seen.has(slug) || connectedSlugs.has(slug)) continue;
    const provider = providers.find((entry) => entry.slug === slug);
    if (!provider) continue;
    seen.add(slug);
    entries.push({ slug, name: provider.name, connected: false });
  }

  return entries;
}

/**
 * Where the model a next run will use comes from.
 *
 * `fallback` is not `global`: the bot CARRIES a model, but no
 * authenticated provider lists it: the worker will fall back silently to the
 * global choice. That is exactly the case to say on screen, otherwise
 * the operator believes they chose.
 */
export type ThreadModelSource = "perBot" | "global" | "fallback";

export type ResolvedThreadModel = {
  model: string;
  /** The requested effort, or `null`: a model that does not reason accepts none. */
  effort: HermesReasoningEffort | null;
  source: ThreadModelSource;
};

/**
 * The model and the effort the NEXT run will use, and where they come from:
 * the client mirror of the worker's resolution (`applyRuntimeModelSelection` then
 * `resolveRunnableSelection`).
 *
 * `null` when nothing is resolvable (empty catalog, no default): both
 * clients then show NOTHING rather than a guessed name. A wrong line about
 * « quel modèle répond » costs more than no line at all.
 *
 * The bot's effort wins over the global, then drops if the resolved model does not
 * reason: the worker removes it in that case, showing it would be a lie.
 */
/**
 * The model a bot with nothing chosen runs on when openedbot imposes nothing:
 * the server's mirror of the worker (`automaticModel`). The host may have no
 * default at all; the worker then picks one (the first connected provider's
 * everyday tier) and the console must name it, not « Aucun modèle » while
 * Hermes answers with Sonnet. A snapshot older than the field falls back to
 * the host's default.
 */
export function automaticRuntimeModel(
  catalog: {
    currentProvider?: string | null;
    runtimeDefaultModel: string | null;
    automaticModel?: { provider: string; model: string; source: "host" | "openedbot" } | null;
  } | null | undefined,
): { provider: string | null; model: string | null; chosenBy: "hermes" | "openedbot" } {
  if (catalog?.automaticModel !== undefined) {
    const automatic = catalog.automaticModel;
    return {
      provider: automatic?.provider ?? null,
      model: automatic?.model ?? null,
      chosenBy: automatic?.source === "openedbot" ? "openedbot" : "hermes",
    };
  }
  return { provider: catalog?.currentProvider ?? null, model: catalog?.runtimeDefaultModel ?? null, chosenBy: "hermes" };
}

/**
 * The « global » model as Settings → Models presents it: the openedbot
 * preference when it exists. With no preference, the model the worker will
 * pick shows (`automaticRuntimeModel`). A preference that names a provider
 * with no model does NOT fall back to the host: measured on 05-09, the composer
 * showed « Modèle global : nemotron » (the fallback the worker wrote into
 * the profile) while settings said gpt-5.6-luna.
 */
export function runtimeGlobalModel(
  runtime: { selectedProvider: string | null; selectedModel: string | null } | null | undefined,
  catalog: Parameters<typeof automaticRuntimeModel>[0],
): string | null {
  if (!runtime) return automaticRuntimeModel(catalog).model;
  if (runtime.selectedModel) return runtime.selectedModel;
  if (runtime.selectedProvider) return null;
  return automaticRuntimeModel(catalog).model;
}

/** No openedbot preference: the global model is the automatic one (`runtimeGlobalModel`). */
export function globalModelIsAutomatic(
  runtime: { selectedProvider: string | null; selectedModel: string | null } | null | undefined,
): boolean {
  return !runtime?.selectedModel?.trim() && !runtime?.selectedProvider?.trim();
}

export function resolveThreadModel(input: {
  botModel: string | null;
  botEffort: string | null;
  globalModel: string | null;
  globalEffort: string | null;
  catalog: ModelCatalogView;
}): ResolvedThreadModel | null {
  const { botModel, botEffort, globalModel, globalEffort, catalog } = input;
  const botModelUsable = botModel !== null && catalog.knownIds.has(botModel);
  const model = botModelUsable ? botModel : globalModel;
  if (model === null || model === "") return null;
  const storedEffort = botEffort ?? globalEffort;
  return {
    model,
    effort:
      catalog.reasoningIds.has(model) && isHermesReasoningEffort(storedEffort) ? storedEffort : null,
    source: botModelUsable ? "perBot" : botModel !== null ? "fallback" : "global",
  };
}
