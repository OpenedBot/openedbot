import { describe, expect, test } from "bun:test";
import { assertPassword } from "../src/http-body";

describe("assertPassword", () => {
  test("rend la saisie intacte, espaces de bord compris", () => {
    expect(assertPassword("  Correct-Horse-Battery ", "Le mot de passe")).toBe("  Correct-Horse-Battery ");
    expect(assertPassword(" ", "Le mot de passe")).toBe(" ");
  });

  test("refuse un type, une saisie vide ou une longueur hors borne", () => {
    for (const value of [undefined, 12, "", "x".repeat(1_025)]) {
      expect(() => assertPassword(value, "Le mot de passe")).toThrow(expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" }));
    }
    expect(assertPassword("x".repeat(1_024), "Le mot de passe")).toHaveLength(1_024);
  });
});
