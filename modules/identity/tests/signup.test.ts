import { describe, expect, test } from "bun:test";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import {
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
    expect(authFailureCode(new HttpError(409, "GOOGLE_ALREADY_LINKED", ""))).toBe("GOOGLE_ALREADY_LINKED");
  });

  test("une panne anonyme sort sous AUTH_SIGNUP_FAILED, jamais en JSON brut", () => {
    expect(authFailureCode(new Error("connection reset"))).toBe("AUTH_SIGNUP_FAILED");
    expect(authFailureCode(new HttpError(500, "DB_UNAVAILABLE", ""))).toBe("AUTH_SIGNUP_FAILED");
  });
});

describe("plus de porte d'inscription (plan 0005)", () => {
  test("un code publié reste nommable, même si plus rien ne le lève", () => {
    expect(authFailureCode(new HttpError(403, "AUTH_EMAIL_NOT_ALLOWED", ""))).toBe("AUTH_EMAIL_NOT_ALLOWED");
  });
});
