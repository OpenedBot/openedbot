import { describe, expect, test } from "bun:test";
import { effectiveThreadModel } from "../src/domain/effective-model";

describe("effectiveThreadModel", () => {
  test("un bot qui hérite (chaîne vide) prend le modèle du runtime", () => {
    expect(effectiveThreadModel("", "x")).toBe("x");
    expect(effectiveThreadModel("  ", "x")).toBe("x");
    expect(effectiveThreadModel(null, "x")).toBe("x");
  });
  test("le réglage du bot l'emporte", () => {
    expect(effectiveThreadModel("y", "x")).toBe("y");
    expect(effectiveThreadModel("y", null)).toBe("y");
  });
  test("rien de renseigné : chaîne vide", () => {
    expect(effectiveThreadModel("", "")).toBe("");
    expect(effectiveThreadModel(null, null)).toBe("");
    expect(effectiveThreadModel(undefined, " ")).toBe("");
  });
});
