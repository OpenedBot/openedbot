import type { OnboardingCompletionPath, OnboardingStateDto, OperatorProfileDto, PatchOnboardingInput } from "@openedbot/contracts-api";
import { request } from "./http";
import type { OnboardingResetScope } from "./types";

export const onboardingApi = {
  /**
   * Le profil de l'opérateur: le handle que les bots emploient pour
   * l'interpeller. `null` tant qu'il n'a pas été saisi. Le roster le porte
   * déjà (`RosterDto.operator`) : cette lecture-ci sert aux surfaces qui n'ont
   * pas de raison de charger tout le roster.
   */
  operator: () => request<{ operator: OperatorProfileDto | null }>("/api/operator"),
  /**
   * Le cloud API rejuge la forme (`USERNAME_INVALID`/`USERNAME_RESERVED`) et
   * l'unicité face aux slugs de bots (`USERNAME_TAKEN`, 409) : la
   * normalisation faite ici n'est qu'un aperçu, jamais la décision.
   */
  saveOperator: (input: { username: string }) =>
    request<{ operator: OperatorProfileDto }>("/api/operator", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  /**
   * L'état persistant du parcours d'accueil : les réponses, le nom de
   * l'espace, et la sortie. L'étape courante n'en fait PAS partie: elle vit
   * en mémoire, chaque entrée recommence à l'accueil (`@/lib/session/onboarding`).
   */
  onboarding: () => request<OnboardingStateDto>("/api/onboarding"),
  /**
   * Écrit ce qui a changé, et rien d'autre : le questionnaire se sauve à
   * chaque clic sans bloquer l'écran, le nom d'espace au moment de valider.
   */
  patchOnboarding: (input: PatchOnboardingInput) =>
    request<OnboardingStateDto>("/api/onboarding", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  /**
   * Marque le parcours terminé, par où l'on est sorti. Idempotent côté
   * cloud API : repasser par là ne réécrit pas `onboardedAt`.
   */
  completeOnboarding: (path: OnboardingCompletionPath) =>
    request<OnboardingStateDto>("/api/onboarding/complete", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  /**
   * Outil de développement : rejoue l'accueil pour la personne connectée
   * (`completed` retombe) et efface la sortie de l'espace courant. La route
   * n'existe qu'en OHB_ENV=development côté cloud API: 404 partout ailleurs.
   *
   * `scope` choisit ce que le cloud API remet à zéro, et le défaut est le
   * geste le moins destructeur : `"flag"` ne touche que le parcours de la
   * personne, `"full"` vide en plus les données applicatives de la base
   * locale (bots, discussions, runs, runtimes…) en conservant l'utilisateur,
   * l'organisation, l'appartenance et la session: on reste connecté. Le type
   * est déclaré ici tant que `@openedbot/contracts-api` ne le publie pas.
   */
  resetOnboarding: (scope: OnboardingResetScope = "flag") =>
    request<OnboardingStateDto>("/api/onboarding/reset", {
      method: "POST",
      body: JSON.stringify({ scope }),
    }),
};
