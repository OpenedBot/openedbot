import { describe, expect, test } from "bun:test";
import { arrivalStepStates } from "../../src/components/bot-arrival-stage";

describe("arrivalStepStates", () => {
  test("sans étape publiée (création en cours, provision en file), la première tourne", () => {
    expect(arrivalStepStates(null)).toEqual(["active", "next", "next"]);
    expect(arrivalStepStates(undefined)).toEqual(["active", "next", "next"]);
  });

  test("les étapes passées sont cochées, la suivante attend", () => {
    expect(arrivalStepStates({ step: "space" })).toEqual(["active", "next", "next"]);
    expect(arrivalStepStates({ step: "rules" })).toEqual(["done", "active", "next"]);
    expect(arrivalStepStates({ step: "tools", tools: ["web"] })).toEqual(["done", "done", "active"]);
  });

  test("une étape inconnue (API plus récente) retombe sur la première", () => {
    expect(arrivalStepStates({ step: "later" as never })).toEqual(["active", "next", "next"]);
  });
});
