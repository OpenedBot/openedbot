import { describe, expect, test } from "bun:test";
import {
  generateTemporaryPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordChecks,
  passwordProblem,
} from "../src/domain/password";

/** Un mot de passe qui satisfait les trois règles : la base des variantes. */
const VALID = "Correct-Horse-Battery";

describe("passwordProblem", () => {
  test("11 caractères -> too_short", () => {
    expect(passwordProblem(`A!${"a".repeat(PASSWORD_MIN_LENGTH - 3)}`)).toBe("too_short");
  });

  test("12 caractères, majuscule et symbole -> null (accepté)", () => {
    expect(passwordProblem(`A!${"a".repeat(PASSWORD_MIN_LENGTH - 2)}`)).toBeNull();
  });

  test("1025 caractères -> too_long", () => {
    expect(passwordProblem(`A!${"a".repeat(PASSWORD_MAX_LENGTH - 1)}`)).toBe("too_long");
  });

  test("1024 caractères -> null (accepté)", () => {
    expect(passwordProblem(`A!${"a".repeat(PASSWORD_MAX_LENGTH - 2)}`)).toBeNull();
  });

  // Assez long mais tout en bas de casse : la longueur seule ne suffit plus.
  test("sans majuscule -> no_uppercase", () => {
    expect(passwordProblem("correct-horse-battery")).toBe("no_uppercase");
  });

  test("sans caractère spécial -> no_symbol", () => {
    expect(passwordProblem("CorrectHorseBattery")).toBe("no_symbol");
  });

  // Un accent ou un espace porte de l'entropie autant qu'une ponctuation.
  test("un accent ou un espace vaut caractère spécial", () => {
    expect(passwordProblem("CorrectHorseBatterie")).toBe("no_symbol");
    expect(passwordProblem("CorrectHorseBatterié")).toBeNull();
    expect(passwordProblem("Correct Horse Battery")).toBeNull();
  });

  test("identique au mot de passe courant -> unchanged", () => {
    expect(passwordProblem(VALID, VALID)).toBe("unchanged");
  });

  test("différent du mot de passe courant -> null", () => {
    expect(passwordProblem(`${VALID}-2`, VALID)).toBeNull();
  });

  test("sans mot de passe courant fourni, jamais unchanged", () => {
    expect(passwordProblem(VALID)).toBeNull();
  });
});

describe("passwordChecks", () => {
  test("dit les trois règles une par une, pour une liste qui vit pendant la frappe", () => {
    expect(passwordChecks("")).toEqual({ length: false, uppercase: false, symbol: false });
    expect(passwordChecks("Aa!")).toEqual({ length: false, uppercase: true, symbol: true });
    expect(passwordChecks("correct-horse-battery")).toEqual({ length: true, uppercase: false, symbol: true });
    expect(passwordChecks(VALID)).toEqual({ length: true, uppercase: true, symbol: true });
  });
});

describe("generateTemporaryPassword", () => {
  // La règle de forme est la seule chose qui compte : un générateur qui
  // sortirait un mot de passe refusé par l'API créerait un compte auquel
  // personne ne peut se connecter.
  test("cent tirages satisfont tous la règle partagée", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(passwordProblem(generateTemporaryPassword())).toBeNull();
    }
  });

  test("la forme est lisible : quatre groupes de quatre, séparés par des tirets", () => {
    expect(generateTemporaryPassword()).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
  });

  test("les caractères ambigus sont absents : ils se dictent mal", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateTemporaryPassword().replace(/-/g, "")).not.toMatch(/[IlO01]/);
    }
  });

  test("deux tirages consécutifs diffèrent", () => {
    expect(generateTemporaryPassword()).not.toBe(generateTemporaryPassword());
  });
});
