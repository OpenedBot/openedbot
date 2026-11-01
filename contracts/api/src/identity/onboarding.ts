export type OperatorProfileDto = { username: string; updatedAt: string };

export const OPERATOR_USERNAME_MIN = 2;

export const OPERATOR_USERNAME_MAX = 32;

export const OPERATOR_USERNAME_RESERVED: readonly string[] = ["user"];

const ONBOARDING_ROLES = [
  "engineer", "product", "designer", "founder", "marketing", "writer", "research", "ops", "student", "other",
] as const;

export type OnboardingRole = (typeof ONBOARDING_ROLES)[number];

const ONBOARDING_USE_CASES = [
  "ship_code", "manage_team", "personal_tasks", "plan_research", "write_publish", "automate_ops", "evaluate", "other",
] as const;

export type OnboardingUseCase = (typeof ONBOARDING_USE_CASES)[number];

export type QuestionnaireAnswers = {
  role: OnboardingRole | null;
  role_other: string | null;
  role_skipped: boolean;
  use_case: OnboardingUseCase[];
  use_case_other: string | null;
  use_case_skipped: boolean;
  version: 2;
};

export type OnboardingCompletionPath = "full" | "runtime_skipped" | "skip_existing";

export type OnboardingStateDto = {
  questionnaire: QuestionnaireAnswers | null;
  workspaceName: string | null;
  /** Sortie de l'espace de travail (datée, idempotente) : informatif, ne décide plus du gate. */
  onboardedAt: string | null;
  completionPath: OnboardingCompletionPath | null;
  /** Le flag de la PERSONNE connectée (`users.onboarding_completed`) : seul déclencheur de `/onboarding`. */
  completed: boolean;
  /**
   * `true` : le compte n'a encore aucune organisation propre. L'application
   * ouvre le parcours `/onboarding` sur l'étape « Organisation » ; les
   * autres champs sont alors vides.
   */
  needsOrganization?: boolean;
  /** Development reset only: replay the organization step on an existing workspace. */
  organizationReset?: boolean;
};

export type PatchOnboardingInput = Partial<{ questionnaire: QuestionnaireAnswers; workspaceName: string }>;

/**
 * Portée de `POST /api/onboarding/reset`, route montée en développement
 * uniquement. `flag` (défaut, corps absent compris) ne touche qu'aux drapeaux
 * d'accueil. `full` vide en plus les données applicatives de la base LOCALE,
 * en gardant la partie utilisateur (`users`, `organizations`, `memberships`,
 * `sessions`, `staff_*`, `subscriptions`) : on rejoue l'accueil sans se
 * reloguer. La réponse est un `OnboardingStateDto` dans les deux cas.
 */
export const ONBOARDING_RESET_SCOPES = ["flag", "full"] as const;

export type OnboardingResetScope = (typeof ONBOARDING_RESET_SCOPES)[number];
