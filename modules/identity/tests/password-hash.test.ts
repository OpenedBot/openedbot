import { describe, expect, test } from "bun:test";
import { verifyPassword } from "../src/application/password-hash";

describe("verifyPassword", () => {
  test("vérifie la saisie exacte, espaces de bord compris", async () => {
    const hash = await Bun.password.hash(" Correct-Horse-Battery ");
    expect(await verifyPassword(" Correct-Horse-Battery ", hash)).toBe(true);
    expect(await verifyPassword("Correct-Horse-Battery", hash)).toBe(false);
  });

  test("un hachage d'avant le correctif, écrit rogné, reste vérifiable par la même saisie", async () => {
    const legacy = await Bun.password.hash("Correct-Horse-Battery");
    expect(await verifyPassword(" Correct-Horse-Battery ", legacy)).toBe(true);
    expect(await verifyPassword("Correct-Horse-Batter", legacy)).toBe(false);
    expect(await verifyPassword("   ", legacy)).toBe(false);
  });
});
