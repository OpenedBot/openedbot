import { describe, expect, test } from "bun:test";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { accessUnlocks, OPEN_SIGNUP_TIER } from "@openedbot/contracts-api";
import {
  accessTierForNewOrganization,
  authFailureCode,
  defaultOrganizationName,
  organizationSlugBase,
  organizationSlugCandidate,
} from "../src/domain/signup";

describe("l'espace né d'un compte Google inconnu", () => {
  test("le slug part du nom affiché, sans accent ni ponctuation", () => {
    expect(organizationSlugBase("camille@example.com", "Camille Lefèvre")).toBe("camille-lefevre");
  });

  test("sans nom affiché, la partie locale de l'e-mail fait foi", () => {
    expect(organizationSlugBase("camille@example.com", null)).toBe("camille");
  });

  test("un nom qui ne laisse aucune lettre retombe sur un slug parlant", () => {
    expect(organizationSlugBase("@@@@", "☂︎")).toBe("espace");
  });

  test("le suffixe de collision reste dans la longueur du slug", () => {
    const base = "a".repeat(60);
    const candidate = organizationSlugCandidate(base, "9f3c1a");
    expect(candidate.endsWith("-9f3c1a")).toBe(true);
    expect(candidate.length).toBeLessThanOrEqual(40);
  });

  test("un nom en forme d'UUID ne devient jamais le segment d'URL de l'espace", () => {
    expect(organizationSlugCandidate("83000000-0000-4000-8000-000000000001", null)).toBe("espace");
  });

  test("le nom de l'espace garde la casse humaine, l'onboarding le renommera", () => {
    expect(defaultOrganizationName("camille@example.com", "Camille Lefèvre")).toBe("Camille Lefèvre");
    expect(defaultOrganizationName("camille@example.com", "   ")).toBe("camille");
  });
});

describe("le nom d'un refus", () => {
  test("une erreur métier déjà nommée traverse telle quelle", () => {
    expect(authFailureCode(new HttpError(409, "MEMBER_QUOTA_REACHED", ""))).toBe("MEMBER_QUOTA_REACHED");
  });

  test("une panne anonyme sort sous AUTH_SIGNUP_FAILED, jamais en JSON brut", () => {
    expect(authFailureCode(new Error("connection reset"))).toBe("AUTH_SIGNUP_FAILED");
    expect(authFailureCode(new HttpError(500, "DB_UNAVAILABLE", ""))).toBe("AUTH_SIGNUP_FAILED");
  });
});

describe("la porte de la liste d’attente", () => {
  test("rend le mode accordé quand l’adresse est validée", () => {
    expect(accessTierForNewOrganization("alpha")).toBe("alpha");
    expect(accessTierForNewOrganization("beta")).toBe("beta");
    expect(accessTierForNewOrganization("classic")).toBe("classic");
  });

  test("refuse une adresse que personne n’a validée, sous son nom", () => {
    try {
      accessTierForNewOrganization(null);
      throw new Error("devait refuser");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(403);
      expect((error as HttpError).code).toBe("AUTH_EMAIL_NOT_ALLOWED");
    }
  });

  test("le refus est un code que le client sait nommer", () => {
    let refusal: unknown;
    try {
      accessTierForNewOrganization(null);
    } catch (error) {
      refusal = error;
    }
    expect(authFailureCode(refusal)).toBe("AUTH_EMAIL_NOT_ALLOWED");
  });

  test("porte éteinte, une adresse neuve naît en classic", () => {
    expect(OPEN_SIGNUP_TIER).toBe("classic");
    expect(accessTierForNewOrganization(null, false)).toBe("classic");
  });

  test("porte éteinte, le mode d’une validation en liste ne l’emporte pas", () => {
    expect(accessTierForNewOrganization("beta", false)).toBe("classic");
    expect(accessTierForNewOrganization("alpha", false)).toBe("classic");
  });
});

describe("les surfaces exclusives", () => {
  test("un compte classic n’ouvre pas une surface beta", () => {
    expect(accessUnlocks("classic", "classic")).toBe(true);
    expect(accessUnlocks("classic", "beta")).toBe(false);
    expect(accessUnlocks("beta", "beta")).toBe(true);
    expect(accessUnlocks("alpha", "beta")).toBe(true);
    expect(accessUnlocks(null, "classic")).toBe(false);
  });
});
