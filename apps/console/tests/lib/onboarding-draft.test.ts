import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearCloudSession, saveCloudSession } from "../../src/lib/cloud-session";
import {
  clearOnboardingDraft,
  EMPTY_RUNTIME_DRAFT,
  ONBOARDING_DRAFT_KEY,
  readOnboardingDraft,
  writeOnboardingDraft,
} from "../../src/lib/onboarding-draft";

function signIn(organizationId = "org-1"): void {
  saveCloudSession({ organizationId, csrfToken: "csrf" });
}

beforeEach(() => {
  window.localStorage.clear();
  signIn();
});

afterEach(() => {
  clearCloudSession();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("readOnboardingDraft", () => {
  test("rend l'étape enregistrée et le choix du runtime : un F5 reprend où on était", () => {
    writeOnboardingDraft({ step: "runtime", runtime: { providerSlug: "xai-oauth", modelId: "grok-4.6" } });

    const draft = readOnboardingDraft();

    expect(draft?.step).toBe("runtime");
    expect(draft?.runtime).toEqual({ providerSlug: "xai-oauth", modelId: "grok-4.6" });
  });

  test("sans brouillon, rien à reprendre", () => {
    expect(readOnboardingDraft()).toBeNull();
  });

  test("un correctif ne perd pas le reste du brouillon", () => {
    writeOnboardingDraft({ step: "runtime" });
    writeOnboardingDraft({ runtime: { ...EMPTY_RUNTIME_DRAFT, modelId: "grok-4.6" } });

    expect(readOnboardingDraft()?.step).toBe("runtime");
    expect(readOnboardingDraft()?.runtime.modelId).toBe("grok-4.6");
  });

  test("une valeur corrompue, d'une autre version ou d'une étape inconnue retombe au début", () => {
    window.localStorage.setItem(ONBOARDING_DRAFT_KEY, "{ pas du json");
    expect(readOnboardingDraft()).toBeNull();

    window.localStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify("runtime"));
    expect(readOnboardingDraft()).toBeNull();

    window.localStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({ version: 0, organizationId: "org-1", step: "runtime" }),
    );
    expect(readOnboardingDraft()).toBeNull();

    window.localStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({ version: 2, organizationId: "org-1", step: "about_you" }),
    );
    expect(readOnboardingDraft()).toBeNull();
  });

  test("un brouillon de l'ancien parcours (version 1, fiche de bot) est jeté, pas repris", () => {
    window.localStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({ version: 1, organizationId: "org-1", step: "runtime", bot: { name: "Hermes" } }),
    );
    expect(readOnboardingDraft()).toBeNull();
  });

  test("des champs du runtime d'un mauvais type sont ramenés à leur valeur vide, pas rendus tels quels", () => {
    window.localStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({
        version: 2,
        organizationId: "org-1",
        step: "runtime",
        runtime: { providerSlug: 42, modelId: null },
      }),
    );

    const draft = readOnboardingDraft();

    expect(draft?.step).toBe("runtime");
    expect(draft?.runtime).toEqual(EMPTY_RUNTIME_DRAFT);
  });

  test("le brouillon d'une autre organisation n'est pas repris", () => {
    writeOnboardingDraft({ step: "workspace" });

    saveCloudSession({ organizationId: "org-2", csrfToken: "csrf" });
    expect(readOnboardingDraft()).toBeNull();
  });

  test("sans session, on n'écrit ni ne relit rien", () => {
    clearCloudSession();

    writeOnboardingDraft({ step: "workspace" });

    expect(window.localStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
    expect(readOnboardingDraft()).toBeNull();
  });

  test("un stockage indisponible ne fait pas planter l'écran", () => {
    const storage = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage bloqué (navigation privée)");
      },
    });
    try {
      expect(readOnboardingDraft()).toBeNull();
      expect(() => writeOnboardingDraft({ step: "runtime" })).not.toThrow();
      expect(() => clearOnboardingDraft()).not.toThrow();
    } finally {
      if (storage) Object.defineProperty(window, "localStorage", storage);
    }
  });
});

describe("clearOnboardingDraft", () => {
  test("efface le brouillon : le suivant ne reprend pas le parcours d'un autre", () => {
    writeOnboardingDraft({ step: "runtime", runtime: { ...EMPTY_RUNTIME_DRAFT, modelId: "grok-4.6" } });

    clearOnboardingDraft();

    expect(window.localStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
    expect(readOnboardingDraft()).toBeNull();
  });
});
