import type { OnboardingCompletionPath, OnboardingStateDto, OperatorProfileDto, PatchOnboardingInput } from "@openedbot/contracts-api";
import { request } from "./http";
import type { OnboardingResetScope } from "./types";

export const onboardingApi = {
  /**
   * The operator's profile: the handle bots use to
   * address them. `null` until it has been entered. The roster already
   * carries it (`RosterDto.operator`): this read serves surfaces that have
   * no reason to load the whole roster.
   */
  operator: () => request<{ operator: OperatorProfileDto | null }>("/api/operator"),
  /**
   * The cloud API rejudges the shape (`USERNAME_INVALID`/`USERNAME_RESERVED`) and
   * uniqueness against bot slugs (`USERNAME_TAKEN`, 409): the
   * normalization done here is only a preview, never the decision.
   */
  saveOperator: (input: { username: string }) =>
    request<{ operator: OperatorProfileDto }>("/api/operator", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  /**
   * The persistent state of the onboarding flow: the answers, the space
   * name, and the exit. The current step is NOT part of it: it lives
   * in memory, each entry starts again at the welcome (`@/lib/session/onboarding`).
   */
  onboarding: () => request<OnboardingStateDto>("/api/onboarding"),
  /**
   * Writes what changed, and nothing else: the questionnaire saves on
   * each click without blocking the screen, the space name when confirming.
   */
  patchOnboarding: (input: PatchOnboardingInput) =>
    request<OnboardingStateDto>("/api/onboarding", {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  /**
   * Marks the flow finished, and by which path one left. Idempotent on the
   * cloud API side: going through it again does not rewrite `onboardedAt`.
   */
  completeOnboarding: (path: OnboardingCompletionPath) =>
    request<OnboardingStateDto>("/api/onboarding/complete", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  /**
   * Development tool: replays onboarding for the signed-in person
   * (`completed` falls back) and clears the current space's exit. The route
   * exists only when OPENEDBOT_ENV=development on the cloud API side: 404 everywhere else.
   *
   * `scope` chooses what the cloud API resets, and the default is the
   * least destructive gesture: `"flag"` touches only the person's
   * flow, `"full"` also empties the local database's application data
   * (bots, discussions, runs, runtimes…) while keeping the user,
   * the organization, the membership and the session: one stays signed in. The type
   * is declared here until `@openedbot/contracts-api` publishes it.
   */
  resetOnboarding: (scope: OnboardingResetScope = "flag") =>
    request<OnboardingStateDto>("/api/onboarding/reset", {
      method: "POST",
      body: JSON.stringify({ scope }),
    }),
};
