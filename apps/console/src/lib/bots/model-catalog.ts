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
  /** Groupes affichables : fournisseurs authentifiés, modèles dédupliqués. */
  groups: ModelGroup[];
  /** Tous les ids proposables : un choix hors de cet ensemble ne sera pas honoré par le worker. */
  knownIds: Set<string>;
  /** Les ids dont le modèle raisonne : seuls eux acceptent un effort. */
  reasoningIds: Set<string>;
};

/** Deux ids qui ne diffèrent que par `.` ou `-` désignent le même modèle. */
function aliasKey(id: string): string {
  return id.toLowerCase().replaceAll(".", "-");
}

/**
 * Hermes liste parfois un modèle sous deux ids (`claude-fable-5.1` et
 * `claude-fable-5-1`) : un seul est proposé. Celui que `keep` nomme (le
 * choix enregistré, qui doit rester visible et sélectionné) l'emporte, sinon
 * le premier listé par Hermes. Les deux restent des choix valides
 * (`knownIds`) : seul l'affichage est dédoublonné.
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
 * Les modèles d'un fournisseur du plus récent au plus ancien, selon la
 * version lue dans leur id (`releaseKey`), sans doublon d'alias
 * (`withoutAliases`). À version égale, l'ordre de Hermes est gardé (tri
 * stable) ; les ids sans version vont à la fin.
 */
export function modelsByRelease<T extends { id: string }>(models: readonly T[], keep: Iterable<string | null> = []): T[] {
  return withoutAliases(models, keep).sort((left, right) => compareRelease(left.id, right.id));
}

/**
 * La vue « picker » du catalogue Hermes, partagée par Réglages → Modèles
 * (onglet Par bot) et la modal d'un bot.
 *
 * Fournisseurs AUTHENTIFIÉS seulement : c'est la condition pour que
 * `resolveRunnableSelection` (worker) honore le choix au lieu de retomber en
 * silence sur le défaut du runtime. Un même id peut être listé par plusieurs
 * fournisseurs (codex ET openai-api) : la valeur enregistrée est l'id seul et
 * Radix exige des valeurs uniques, donc chaque id n'apparaît qu'une fois, dans
 * le premier groupe qui le liste.
 */
export function catalogModelView(
  providers: RuntimeModelProviderDto[],
  /** Les ids déjà choisis (bot, modèle global) : jamais masqués comme doublon d'alias. */
  keep: Iterable<string | null> = [],
): ModelCatalogView {
  const kept = [...keep];
  const authenticated = providers.filter((provider) => provider.authenticated && provider.models.length > 0);
  const knownIds = new Set(authenticated.flatMap((provider) => provider.models.map((model) => model.id)));
  const reasoningIds = new Set(
    authenticated.flatMap((provider) => provider.models.filter((model) => model.reasoning).map((model) => model.id)),
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
  return { groups, knownIds, reasoningIds };
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
 * D'où vient le modèle qu'un prochain run utilisera.
 *
 * `fallback` n'est pas `global` : le bot PORTE un modèle, mais aucun
 * fournisseur authentifié ne le liste : le worker retombera en silence sur le
 * choix global. C'est exactement le cas qu'il faut dire à l'écran, sans quoi
 * l'opérateur croit avoir choisi.
 */
export type ThreadModelSource = "perBot" | "global" | "fallback";

export type ResolvedThreadModel = {
  model: string;
  /** L'effort demandé, ou `null` : un modèle qui ne raisonne pas n'en accepte aucun. */
  effort: HermesReasoningEffort | null;
  source: ThreadModelSource;
};

/**
 * Le modèle et l'effort que le PROCHAIN run utilisera, et d'où ils viennent :
 * miroir client de la résolution du worker (`applyRuntimeModelSelection` puis
 * `resolveRunnableSelection`).
 *
 * `null` quand rien n'est résoluble (catalogue vide, aucun défaut) : les deux
 * clients n'affichent alors RIEN plutôt qu'un nom deviné. Une ligne fausse sur
 * « quel modèle répond » coûte plus cher que pas de ligne du tout.
 *
 * L'effort du bot prime sur le global, puis tombe si le modèle résolu ne
 * raisonne pas : le worker le retire dans ce cas, l'afficher serait mentir.
 */
/**
 * Le modèle « global » tel que Réglages → Modèles le présente : la préférence
 * openedbot quand elle existe. Sans préférence, Hermes décide et c'est le modèle
 * courant de l'hôte qui s'affiche. Une préférence qui nomme un fournisseur
 * sans modèle ne retombe PAS sur l'hôte : mesuré le 05-09, le composer
 * affichait « Modèle global : nemotron » (le repli écrit par le worker dans
 * le profil) pendant que les réglages disaient gpt-5.6-luna.
 */
export function runtimeGlobalModel(
  runtime: { selectedProvider: string | null; selectedModel: string | null } | null | undefined,
  catalog: { runtimeDefaultModel: string | null } | null | undefined,
): string | null {
  if (!runtime) return catalog?.runtimeDefaultModel ?? null;
  if (runtime.selectedModel) return runtime.selectedModel;
  if (runtime.selectedProvider) return null;
  return catalog?.runtimeDefaultModel ?? null;
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
