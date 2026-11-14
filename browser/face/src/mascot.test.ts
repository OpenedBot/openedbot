import { describe, expect, test } from "bun:test";
import { SHAPES, defaultFaceFor } from "@openedbot/contracts-api";
import { MASCOT_SHAPE, isMascotFace, mascotFace, resolveMascot } from "./mascot";

describe("cat face", () => {
  test("a cat is `shape: chat`, without artwork", () => {
    expect(isMascotFace(mascotFace("orange", "pill", "antenna"))).toBe(true);
    expect(isMascotFace({ ...mascotFace("orange", "pill", null), artwork: "ember" })).toBe(false);
    expect(isMascotFace({ palette: "orange", shape: "cercle", eyes: "neutre" })).toBe(false);
    expect(isMascotFace(null)).toBe(false);
  });

  test("the bare cat carries no accessory key", () => {
    expect(mascotFace("vert", "happy", null)).toEqual({ shape: MASCOT_SHAPE, palette: "vert", eyes: "happy" });
  });

  test("resolves the landing colours, Méca's slate included", () => {
    expect(resolveMascot(mascotFace("orange", "pill", "antenna"))).toEqual({ colorId: "orange", color: "#f08a24", eyes: "pill", accessory: "antenna" });
    expect(resolveMascot(mascotFace("ardoise", "square", "gear")).color).toBe("#6b7a8f");
  });

  test("an unknown value falls back to the plain brand cat, never to nothing", () => {
    const resolved = resolveMascot({ shape: MASCOT_SHAPE, palette: "plaid", eyes: "laser", accessory: "cape" });
    expect(resolved).toEqual({ colorId: null, color: "#f08a24", eyes: "pill", accessory: null });
  });

  test("the cat stays out of the bloub shapes: the derived faces of existing bots do not move", () => {
    expect(SHAPES.map((shape) => shape.id)).not.toContain(MASCOT_SHAPE);
    expect(defaultFaceFor("bot-1").shape).not.toBe(MASCOT_SHAPE);
  });
});
