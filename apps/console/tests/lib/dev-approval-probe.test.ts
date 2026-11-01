import { describe, expect, test } from "bun:test";
import { SHOW_FEATURE_LAB } from "../../src/lib/dev-approval-probe";

describe("SHOW_FEATURE_LAB", () => {
  test("n'est vrai que pour le booléen Vite import.meta.env.DEV", () => {
    expect(SHOW_FEATURE_LAB).toBe(import.meta.env.DEV === true);
  });
});
