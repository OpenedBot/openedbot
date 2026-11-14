/**
 * The PWA welcome flow, Multica model.
 *
 * A welcome screen (« welcome », product intro, never persisted and without
 * a progress indicator), then two steps in the rail, in this order
 * and no other: « Espace de travail » (the organization, its name, and
 * the username) and « Configuration » (the machine,
 * the AI provider and the runtime model). No bot is created here:
 * leaving opens the application, which offers the first bot.
 */
export type OnboardingStep = "welcome" | "workspace" | "runtime";

/** The rail steps, without `welcome`, which is not progress. */
export type RailStep = Exclude<OnboardingStep, "welcome">;

/**
 * The canonical order of the persisted steps. The only source of truth for "what
 * comes after what": the progress indicator and navigation derive from it.
 */
export const ONBOARDING_STEP_ORDER: readonly RailStep[] = [
  "workspace",
  "runtime",
] as const;

/** The step that follows `from` in the rail, `null` after the last (or off the rail). */
export function nextStep(from: OnboardingStep): RailStep | null {
  if (from === "welcome") return ONBOARDING_STEP_ORDER[0]!;
  const index = ONBOARDING_STEP_ORDER.indexOf(from);
  if (index < 0 || index >= ONBOARDING_STEP_ORDER.length - 1) return null;
  return ONBOARDING_STEP_ORDER[index + 1]!;
}

/** The previous step: the first of the rail returns to welcome; welcome has no previous step. */
export function prevStep(from: OnboardingStep): OnboardingStep | null {
  if (from === "welcome") return null;
  const index = ONBOARDING_STEP_ORDER.indexOf(from);
  return index <= 0 ? "welcome" : ONBOARDING_STEP_ORDER[index - 1]!;
}

/** The rank (0-based) of a step in the rail; `welcome` is 0. */
export function railIndex(step: OnboardingStep): number {
  return Math.max(0, ONBOARDING_STEP_ORDER.indexOf(step as RailStep));
}
