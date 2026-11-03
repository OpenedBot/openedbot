import type { HermesClient, HermesModelOptions } from "@openedbot/hermes";
import { ProfileImportError } from "../domain/errors";

export type HostProfileModelSelection = { provider: string; model: string };
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

export async function resolvedHostProfileModel(
  bot: { model?: string | null; provider?: string | null },
  runtime: { selectedProvider?: string | null; selectedModel?: string | null },
  loadCatalog: () => Promise<Pick<HermesModelOptions, "providers">>,
): Promise<HostProfileModelSelection | null> {
  const own = bot.model?.trim() || null;
  const model = own ?? runtime.selectedModel?.trim();
  if (!model) return null;
  const requested = bot.provider?.trim() || (own ? null : runtime.selectedProvider?.trim());
  const catalog = await loadCatalog();
  const listed = catalog.providers.find((entry) => entry.authenticated
    && (!requested || entry.slug === requested) && entry.models.some((candidate) => candidate.id === model));
  // Un bot qui suit le runtime reprend un modèle que ce runtime fait déjà
  // tourner : le catalogue statique de Hermes peut retarder sur un modèle
  // récent (gpt-6-luna absent d'openai-codex le 2026-10-17), ce qui refusait
  // toute création. Le fournisseur doit rester authentifié ; un modèle propre
  // au bot reste vérifié contre le catalogue.
  const inherited = !listed && !own && requested
    ? catalog.providers.find((entry) => entry.authenticated && entry.slug === requested)
    : undefined;
  const provider = listed ?? inherited;
  if (!provider || !TOKEN.test(model) || !TOKEN.test(provider.slug)) {
    throw new ProfileImportError(409, "BOT_MODEL_UNAVAILABLE", "Ce modèle n’est disponible chez aucun fournisseur authentifié correspondant dans le catalogue Hermes. Choisissez un modèle disponible.");
  }
  return { provider: provider.slug, model };
}

export async function applyHostProfileModel(
  client: Pick<HermesClient, "hostSetProfileModel">, slug: string, selection: HostProfileModelSelection | null,
): Promise<{ applied: boolean }> {
  if (!selection) return { applied: false };
  try { return { applied: (await client.hostSetProfileModel(slug, selection)).applied }; }
  catch { return { applied: false }; }
}

export async function resolveImportedModel(
  profile: { name: string; model: { default: string | null; provider: string | null } },
  runtime: { selectedProvider?: string | null; selectedModel?: string | null },
  loadCatalog: () => Promise<Pick<HermesModelOptions, "providers">>,
): Promise<{ selection: HostProfileModelSelection | null; model: string | null; limitations: string[] }> {
  const wanted = profile.model;
  try {
    const selection = await resolvedHostProfileModel({ model: wanted.default, provider: wanted.provider }, runtime, loadCatalog);
    return { selection, model: wanted.default ? selection?.model ?? null : null, limitations: selection ? [] : [`profile-model-unset:${profile.name}`] };
  } catch (error) {
    if (!(error instanceof ProfileImportError) || error.code !== "BOT_MODEL_UNAVAILABLE") throw error;
    let selection: HostProfileModelSelection | null = null;
    try { selection = await resolvedHostProfileModel({}, runtime, loadCatalog); }
    catch (fallback) { if (!(fallback instanceof ProfileImportError) || fallback.code !== "BOT_MODEL_UNAVAILABLE") throw fallback; }
    return {
      selection, model: null,
      limitations: [`model-not-available:${profile.name}:${wanted.provider ?? ""}/${wanted.default ?? ""}`, ...(selection ? [] : [`profile-model-unset:${profile.name}`])],
    };
  }
}
