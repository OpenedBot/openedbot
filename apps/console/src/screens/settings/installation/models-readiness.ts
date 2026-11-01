import type { RuntimeModelCatalogDto, RuntimePublicDto } from "@openedbot/contracts-api";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";

/**
 * Ce que l'écran Modèles a le droit de proposer, à cet instant.
 *
 * Choisir un modèle n'a de sens que si TOUTE la chaîne tient : un runtime
 * déclaré, joignable, dont Hermes rend le catalogue, et qui porte au moins un
 * fournisseur authentifié. Chaque maillon manquant se répare ailleurs : écran
 * Runtime pour les premiers, annuaire des fournisseurs pour le dernier. Rendre
 * les sélecteurs malgré tout promettait un choix que le serveur refuse ensuite
 * (409 `RUNTIME_MODEL_PROVIDER_UNAUTHENTICATED`) ou qu'aucun run n'honorerait.
 */
export type RuntimeReadiness =
  /** Aucun runtime n'est déclaré pour l'organisation. */
  | { state: "missing" }
  /** Pas de catalogue, et la dernière vérification connue n'avait pas abouti. */
  | { state: "unproven"; status: RuntimeHealthStatus }
  /** Pas de catalogue, alors que la dernière vérification connue avait abouti. */
  | { state: "catalog_unreachable" }
  /** Catalogue lu, aucun fournisseur authentifié : le choix est impossible, la réparation est sur place. */
  | { state: "no_provider" }
  /** Tout tient. `pinned` : un modèle est imposé, sinon Hermes applique son défaut. */
  | { state: "ready"; pinned: boolean };

/**
 * Le catalogue prime sur la santé : preuve vivante contre preuve datée.
 *
 * `lastHealthStatus` n'est écrit que par une action d'opérateur (création,
 * « Tester la connexion », activation, enrôlement) : il n'existe aucune sonde de
 * fond. Un Hermes tombé cinq minutes, testé pendant sa panne puis revenu,
 * garde donc `unreachable` en base pour toujours. Trancher là-dessus fermait
 * l'écran d'un runtime qui vient de répondre. On ne s'en sert que lorsque le
 * catalogue manque : il nomme alors la cause probable, au lieu de dire
 * « illisible » sans rien expliquer.
 *
 * `catalog` doit être le catalogue réellement en main : un rafraîchissement
 * raté qui laisse des données en cache n'est pas une absence de catalogue.
 */
export function runtimeReadiness(input: {
  runtime: RuntimePublicDto | null;
  catalog: RuntimeModelCatalogDto | null;
}): RuntimeReadiness {
  const { runtime, catalog } = input;
  if (!runtime) return { state: "missing" };
  if (!catalog) {
    return runtime.lastHealthStatus === "healthy"
      ? { state: "catalog_unreachable" }
      : { state: "unproven", status: runtime.lastHealthStatus };
  }
  if (!catalog.hasUsableProvider) return { state: "no_provider" };
  // Ce que l'écran peut affirmer se lit sur la sélection, pas sur une date :
  // toutes les routes de création posent `healthy` et `last_probed_at = now()`,
  // donc l'âge d'un runtime ne se déduit d'aucun horodatage. Et une sélection
  // vide ne prouve pas « jamais réglé » : « laisser Hermes décider » s'écrit
  // exactement pareil. On ne dit donc que le fait présent : aucun modèle
  // imposé, c'est le défaut d'Hermes qui répond.
  return { state: "ready", pinned: runtime.selectedProvider !== null };
}
