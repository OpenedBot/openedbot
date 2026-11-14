import { describe, expect, test } from "bun:test";
import { ApiError, userFacingError } from "../../src/lib/api";

describe("userFacingError", () => {
  test("refus métier : le message de l'API", () => {
    expect(userFacingError(new ApiError(400, "Trop long"), "fallback")).toBe("Trop long");
  });

  test("exception de programmation : le fallback, pas le TypeError", () => {
    expect(
      userFacingError(
        new TypeError(
          "crypto.randomUUID is not a function. (In 'crypto.randomUUID()', 'crypto.randomUUID' is undefined)",
        ),
        "Le message n'est pas parti.",
      ),
    ).toBe("Le message n'est pas parti.");
  });

  test("ApiError vide : le fallback", () => {
    expect(userFacingError(new ApiError(500, "   "), "fallback")).toBe("fallback");
  });
});
