/**
 * Les tokens qu'OpenAI offre chaque jour, et ce qu'ils coûtent vraiment.
 *
 * Le programme n'est pas gratuit au sens où on l'entend : les paliers ne
 * s'appliquent qu'au **trafic partagé avec OpenAI** (prompts et réponses
 * versés à leur entraînement), activé dans « Data controls → Sharing » sur
 * platform.openai.com. L'application affiche donc toujours le palier ET sa
 * contrepartie : un chiffre seul serait une incitation, pas une information.
 *
 * Relevé le 14-08-2026 sur platform.openai.com. Les listes sont **exactes**,
 * jamais des préfixes : `gpt-5.4` et `gpt-5.4-nano` ne sont pas dans le même
 * palier, et un modèle absent des deux (`gpt-5.5`, `gpt-5.6-*`, les codex que
 * ce runtime expose aussi) est facturé au tarif normal.
 */

/** Le seul fournisseur concerné par le programme. */
export const OPENAI_FREE_TIER_PROVIDER = "openai-api";

const TIERS: ReadonlyArray<{ tokensPerDay: number; models: ReadonlySet<string> }> = [
  {
    tokensPerDay: 10_000_000,
    models: new Set([
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o-mini",
      "o3-mini",
      "o4-mini",
    ]),
  },
  {
    tokensPerDay: 1_000_000,
    models: new Set([
      "gpt-5.4",
      "gpt-5.2",
      "gpt-5.1",
      "gpt-5",
      "gpt-4.1",
      "gpt-4o",
      "o1",
      "o3",
    ]),
  },
];

/**
 * Le palier quotidien offert pour ce modèle, ou `null` s'il n'en a aucun.
 *
 * L'appelant doit avoir vérifié que le fournisseur est bien
 * `OPENAI_FREE_TIER_PROVIDER` : un `gpt-4o` servi par un agrégateur tiers
 * n'ouvre droit à rien.
 */
export function openAiFreeTokensPerDay(model: string): number | null {
  const id = model.trim().toLowerCase();
  if (!id) return null;
  return TIERS.find((tier) => tier.models.has(id))?.tokensPerDay ?? null;
}
