import type { RuntimeModelProviderDto } from "@openedbot/contracts-api";

/**
 * Fournisseur que le worker résoudrait actuellement pour un bot.
 *
 * C'est une aide d'affichage, pas une preuve de facturation : `runs` ne porte
 * pas encore le fournisseur réellement débité. L'ordre reproduit
 * `resolveRunnableSelection` du worker : modèle explicite du bot, puis
 * sélection runtime, fournisseur courant et enfin premier fournisseur
 * utilisable. Si Hermes résout l'agrégat virtuel `moa`, l'aide renvoie `null` :
 * elle ne réattribue jamais ses jetons à un fournisseur réel.
 */
export function resolveBotProvider(
  botModel: string | null,
  runtime: { selectedProvider: string | null; selectedModel: string | null },
  providers: readonly RuntimeModelProviderDto[],
): string | null {
  const authenticated = providers.filter((provider) => provider.authenticated);
  const explicitModel = botModel?.trim() || null;
  const model = explicitModel ?? (runtime.selectedModel?.trim() || null);
  const publicProvider = (provider: RuntimeModelProviderDto | undefined): string | null =>
    provider && provider.slug !== "moa" ? provider.slug : null;

  if (model && !explicitModel && runtime.selectedProvider) {
    const selected = authenticated.find((provider) => provider.slug === runtime.selectedProvider);
    if (selected?.models.some((candidate) => candidate.id === model)) return publicProvider(selected);
  }

  if (model) {
    const resolved = authenticated.find((provider) => provider.models.some((candidate) => candidate.id === model));
    if (resolved) return publicProvider(resolved);
  }

  if (explicitModel) return null;
  const current = authenticated.find((provider) => provider.isCurrent && provider.models.some((candidate) => candidate.isRuntimeDefault));
  if (current) return publicProvider(current);
  return publicProvider(authenticated.find((provider) => provider.slug !== "moa" && provider.models.length > 0));
}
