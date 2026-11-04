import { describe, expect, test } from "bun:test";
import { otpErase, otpSlots, otpWrite } from "./input-otp";

describe("les cases du code à usage unique", () => {
  test("effacer une case du milieu laisse les autres chiffres à leur place", () => {
    const erased = otpErase(otpSlots("123456", 6), 2);
    expect(erased).toEqual({ slots: ["1", "2", "", "4", "5", "6"], focus: 2 });
    const retyped = otpWrite(erased.slots, 2, "9");
    expect(retyped.join("")).toBe("129456");
  });

  test("le code reste incomplet tant qu'une case est vide", () => {
    const erased = otpErase(otpSlots("123456", 6), 2);
    expect(erased.slots.join("")).toHaveLength(5);
  });

  test("Backspace sur une case vide efface la précédente et y revient", () => {
    expect(otpErase(["1", "2", "", "", "", ""], 2)).toEqual({ slots: ["1", "", "", "", "", ""], focus: 1 });
    expect(otpErase(["", "", "", "", "", ""], 0)).toEqual({ slots: ["", "", "", "", "", ""], focus: 0 });
  });

  test("un collage se répartit depuis la case visée sans dépasser la dernière", () => {
    expect(otpWrite(otpSlots("", 6), 4, "12-34")).toEqual(["", "", "", "", "1", "2"]);
  });
});
