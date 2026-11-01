import { describe, expect, test } from "bun:test";
import type { AuthStatus } from "../../../src/lib/session/auth-status";
import { needsPasswordChange, PASSWORD_CHANGE_PATH } from "../../../src/lib/session/password-change-gate";

function status(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return {
    kind: "session",
    ssoEnabled: true,
    user: { email: "operateur@example.test", displayName: null },
    sessionId: "web",
    reason: null,
    mustChangePassword: false,
    ...overrides,
  };
}

describe("garde du mot de passe temporaire", () => {
  test("un mot de passe temporaire renvoie sur l’écran de sécurité", () => {
    expect(needsPasswordChange(status({ mustChangePassword: true }), "/")).toBe(true);
    expect(needsPasswordChange(status({ mustChangePassword: true }), "/settings/models")).toBe(true);
  });

  test("l’écran dédié lui-même ne se redirige pas vers lui-même", () => {
    expect(needsPasswordChange(status({ mustChangePassword: true }), PASSWORD_CHANGE_PATH)).toBe(false);
  });

  /**
   * La destination est un écran À PART, pas une rubrique des réglages. Une
   * toute première connexion n'a pas à traverser un écran d'administration,
   * avec ses sessions et sa barre latérale, pour trouver le seul champ qui la
   * laisse entrer.
   */
  test("la destination n’est pas une page de réglages", () => {
    expect(PASSWORD_CHANGE_PATH).toBe("/change-password");
    expect(PASSWORD_CHANGE_PATH.startsWith("/settings")).toBe(false);
  });

  test("l’ancienne destination est redirigée comme n’importe quelle autre page", () => {
    // `/settings/security` garde son formulaire pour tous les autres jours,
    // mais tant que le mot de passe est temporaire il n'ouvre rien.
    expect(needsPasswordChange(status({ mustChangePassword: true }), "/settings/security")).toBe(true);
  });

  test("un compte ordinaire n’est jamais dérouté", () => {
    expect(needsPasswordChange(status(), "/")).toBe(false);
  });

  test("sans session, ou sans réponse du cloud API, personne n’est enfermé", () => {
    const none: AuthStatus = {
      kind: "none", ssoEnabled: true, user: null, sessionId: null, reason: "AUTH_REQUIRED", mustChangePassword: false,
    };
    const unknown: AuthStatus = {
      kind: "unknown", ssoEnabled: false, user: null, sessionId: null, reason: null, mustChangePassword: true,
    };
    expect(needsPasswordChange(none, "/")).toBe(false);
    expect(needsPasswordChange(unknown, "/")).toBe(false);
  });
});
