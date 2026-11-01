import { describe, expect, test } from "bun:test";
import { isMobileViewport } from "./use-mobile";

describe("isMobileViewport", () => {
  test("garde les grands iPhone dans la coque mobile en portrait et paysage", () => {
    expect(isMobileViewport(430, 932, true)).toBe(true);
    expect(isMobileViewport(932, 430, true)).toBe(true);
    expect(isMobileViewport(440, 956, true)).toBe(true);
    expect(isMobileViewport(956, 440, true)).toBe(true);
  });

  test("ne confond pas une fenêtre desktop large et basse avec un téléphone", () => {
    expect(isMobileViewport(932, 430, false)).toBe(false);
    expect(isMobileViewport(1440, 700, false)).toBe(false);
  });
});
