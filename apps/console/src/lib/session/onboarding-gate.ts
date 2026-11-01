import type { OnboardingStateDto } from "@openedbot/contracts-api";

/**
 * Le déclencheur du parcours d'accueil, et le seul : `completed === false`,
 * c'est-à-dire le cloud API qui dit « CETTE personne n'est pas encore sortie
 * de l'accueil » (`users.onboarding_completed`, migration 0025).
 *
 * `onboardedAt`, la sortie datée de l'ESPACE, ne décide plus : un membre
 * invité dans un espace déjà onboardé fait quand même son propre parcours, et
 * un reset de développement rejoue l'accueil sans toucher l'historique de
 * l'espace. Strictement `false` : `undefined` (un cloud API d'avant le flag,
 * ou une lecture qui n'a pas abouti) ne prouve rien et ne redirige pas.
 */
export function needsOnboarding(state: OnboardingStateDto | undefined): boolean {
  return state?.completed === false;
}

/** L'inverse exact, pour la garde de la route `/onboarding` elle-même. */
export function hasCompletedOnboarding(state: OnboardingStateDto | undefined): boolean {
  return state?.completed === true;
}
