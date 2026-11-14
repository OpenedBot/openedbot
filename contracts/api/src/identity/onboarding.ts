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
  /** Leaving the workspace (dated, idempotent): informational, no longer decides the gate. */
  onboardedAt: string | null;
  completionPath: OnboardingCompletionPath | null;
  /** The connected PERSON's flag (`users.onboarding_completed`): the only trigger of `/onboarding`. */
  completed: boolean;
  /**
   * `true`: the account still has no organization of its own. The application
   * opens the `/onboarding` flow on the « Organisation » step; the
   * other fields are then empty.
   */
  needsOrganization?: boolean;
  /** Development reset only: replay the organization step on an existing workspace. */
  organizationReset?: boolean;
};

export type PatchOnboardingInput = Partial<{ questionnaire: QuestionnaireAnswers; workspaceName: string }>;

/**
 * Scope of `POST /api/onboarding/reset`, a route mounted in development
 * only. `flag` (the default, including an absent body) touches only the
 * welcome flags. `full` also empties the application data of the LOCAL
 * database, keeping the user side (`users`, `organizations`, `memberships`,
 * `sessions`, `subscriptions`, and the tables only a plug-in writes): the welcome is replayed without
 * signing in again. The response is an `OnboardingStateDto` in both cases.
 */
export const ONBOARDING_RESET_SCOPES = ["flag", "full"] as const;

export type OnboardingResetScope = (typeof ONBOARDING_RESET_SCOPES)[number];
