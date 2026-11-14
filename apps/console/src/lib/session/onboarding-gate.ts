import type { OnboardingStateDto } from "@openedbot/contracts-api";

/**
 * The trigger of the welcome flow, and the only one: `completed === false`,
 * that is the cloud API saying "THIS person has not yet left
 * the welcome flow" (`users.onboarding_completed`, migration 0025).
 *
 * `onboardedAt`, the dated exit of the WORKSPACE, no longer decides: a member
 * invited into an already onboarded workspace still does their own flow, and
 * a development reset replays the welcome flow without touching the
 * workspace history. Strictly `false`: `undefined` (a cloud API from before the flag,
 * or a read that did not succeed) proves nothing and does not redirect.
 */
export function needsOnboarding(state: OnboardingStateDto | undefined): boolean {
  return state?.completed === false;
}

/** The exact inverse, for the guard of the `/onboarding` route itself. */
export function hasCompletedOnboarding(state: OnboardingStateDto | undefined): boolean {
  return state?.completed === true;
}
