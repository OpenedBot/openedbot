import { describe, expect, test } from "bun:test";
import type { OnboardingStateDto } from "@openedbot/contracts-api";
import { hasCompletedOnboarding, needsOnboarding } from "../../../src/lib/session/onboarding-gate";

function state(overrides: Partial<OnboardingStateDto>): OnboardingStateDto {
  return {
    questionnaire: null,
    workspaceName: "Dev",
    onboardedAt: null,
    completionPath: null,
    completed: false,
    ...overrides,
  };
}

describe("needsOnboarding", () => {
  test("redirige quand la personne n'a pas terminé, MÊME si l'espace est déjà onboardé", () => {
    expect(needsOnboarding(state({ completed: false, onboardedAt: "2026-08-01T10:00:00.000Z", completionPath: "full" })))
      .toBe(true);
  });

  test("ne redirige pas quand la personne a terminé, même sans date de sortie de l'espace", () => {
    expect(needsOnboarding(state({ completed: true, onboardedAt: null }))).toBe(false);
  });

  test("une lecture absente ne prouve rien : pas de redirection", () => {
    expect(needsOnboarding(undefined)).toBe(false);
    // Un cloud API d'avant le flag : `completed` manque, `onboardedAt` seul ne décide plus.
    expect(needsOnboarding({ ...state({}), completed: undefined as unknown as boolean, onboardedAt: null })).toBe(false);
  });
});

describe("hasCompletedOnboarding", () => {
  test("n'écarte de /onboarding que la personne qui a terminé", () => {
    expect(hasCompletedOnboarding(state({ completed: true }))).toBe(true);
    expect(hasCompletedOnboarding(state({ completed: false, onboardedAt: "2026-08-01T10:00:00.000Z" }))).toBe(false);
    expect(hasCompletedOnboarding(undefined)).toBe(false);
  });
});
