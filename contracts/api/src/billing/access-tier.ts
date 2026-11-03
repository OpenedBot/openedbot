/**
 * Le mode d'accès accordé à une adresse validée depuis la liste d'attente.
 *
 * Ce module est ISOMORPHE : l'API valide ce que le backoffice envoie, le
 * backoffice dessine les trois choix, et les deux lisent la même liste. Un
 * quatrième mode s'ajoute ici, une seule fois, et la contrainte SQL
 * `waitlist_signups_access_tier_check` (0068) le suit.
 *
 * `approved_at` ouvre l'entrée quand la porte liste d'attente est allumée
 * (`product_features.waitlist`). Le mode, recopié sur `users.access_tier` à
 * la création, est la clé des surfaces exclusives : `accessUnlocks(tier,
 * minimum)` au point d'usage, jamais une comparaison de chaînes dispersée.
 *
 * Rang : `classic` (entrée ouverte) < `beta` < `alpha` (le plus exclusif).
 * Une surface en `beta` est donc ouverte aux comptes `beta` et `alpha`.
 */
export const ACCESS_TIERS = ["alpha", "beta", "classic"] as const;

export type AccessTier = (typeof ACCESS_TIERS)[number];

/**
 * Mode posé sur un compte neuf hors liste, porte éteinte : `classic`, l'entrée
 * ouverte, depuis la fin de l'alpha et de la bêta (2026-10-17). Les modes
 * `beta` et `alpha` restent ceux qu'une validation en liste accorde.
 */
export const OPEN_SIGNUP_TIER: AccessTier = "classic";

const ACCESS_TIER_RANK: Record<AccessTier, number> = {
  classic: 0,
  beta: 1,
  alpha: 2,
};

export function isAccessTier(value: unknown): value is AccessTier {
  return typeof value === "string" && (ACCESS_TIERS as readonly string[]).includes(value);
}

/** True when `tier` meets or exceeds `minimum` on the exclusive-feature rank. */
export function accessUnlocks(tier: AccessTier | null, minimum: AccessTier): boolean {
  if (tier === null) return false;
  return ACCESS_TIER_RANK[tier] >= ACCESS_TIER_RANK[minimum];
}
