import { describe, expect, test } from "bun:test";
import { emailDomain, isDomainValid, isEmailSyntaxValid, normalizeEmail } from "../src/domain/email-address";

describe("normalizeEmail", () => {
  test("retire les espaces et met en minuscules", () => {
    expect(normalizeEmail("  Kev@Example.COM ")).toBe("kev@example.com");
  });
});

describe("isEmailSyntaxValid", () => {
  test("accepte ce qu'une personne tape vraiment", () => {
    for (const value of [
      "kev@example.com",
      "camille.martin@laposte.net",
      "kev+liste@example.co.uk",
      "k_e-v'a@sous-domaine.example.fr",
      "chiffre123@example123.io",
      "  Kev@Example.COM ",
    ]) {
      expect(isEmailSyntaxValid(value)).toBe(true);
    }
  });

  test("refuse ce que la RFC tolère mais qu'aucun formulaire ne veut", () => {
    for (const value of [
      "a@b", // domaine sans point
      "kev@localhost", // une seule étiquette
      "kev@1.2.3.4", // extension numérique
      "kev@example.c", // extension d'une lettre
      "kev@exemple.123", // extension numérique
    ]) {
      expect(isEmailSyntaxValid(value)).toBe(false);
    }
  });

  test("refuse les formes cassées", () => {
    for (const value of [
      "",
      "kev",
      "@example.com",
      "kev@",
      "kev @example.com",
      "kev@exam ple.com",
      "a@b@example.com",
      ".kev@example.com",
      "kev.@example.com",
      "kev..a@example.com",
      "kev@-example.com",
      "kev@example-.com",
      "kev@example..com",
      "kev@.example.com",
      "kev@example.com.",
    ]) {
      expect(isEmailSyntaxValid(value)).toBe(false);
    }
  });

  test("tient les bornes de longueur", () => {
    expect(isEmailSyntaxValid(`${"a".repeat(64)}@example.com`)).toBe(true);
    expect(isEmailSyntaxValid(`${"a".repeat(65)}@example.com`)).toBe(false);
    expect(isEmailSyntaxValid(`a@${"b".repeat(64)}.com`)).toBe(false);
  });
});

describe("isDomainValid", () => {
  test("sépare un domaine nommé d'un nom d'hôte local", () => {
    expect(isDomainValid("example.com")).toBe(true);
    expect(isDomainValid("a.example.co.uk")).toBe(true);
    expect(isDomainValid("localhost")).toBe(false);
    expect(isDomainValid("openedbot.local")).toBe(true);
  });
});

describe("emailDomain", () => {
  test("rend le domaine normalisé", () => {
    expect(emailDomain("  Kev@Example.COM ")).toBe("example.com");
    expect(emailDomain("pas-une-adresse")).toBe("");
  });
});
