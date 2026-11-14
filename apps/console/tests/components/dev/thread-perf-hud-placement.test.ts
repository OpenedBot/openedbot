import { describe, expect, test } from "bun:test";
import { clampHudPosition } from "../../../src/components/dev/thread-perf-hud";

const VIEWPORT = { width: 1440, height: 900 };
const SIZE = { width: 300, height: 500 };

describe("clampHudPosition", () => {
  test("a position inside the window is kept", () => {
    expect(clampHudPosition({ left: 400, top: 120 }, SIZE, VIEWPORT)).toEqual({ left: 400, top: 120 });
  });

  test("the panel never leaves the window and its header stays reachable", () => {
    expect(clampHudPosition({ left: -50, top: -20 }, SIZE, VIEWPORT)).toEqual({ left: 8, top: 8 });
    expect(clampHudPosition({ left: 2000, top: 2000 }, SIZE, VIEWPORT)).toEqual({ left: 1132, top: 860 });
  });

  test("a window narrower than the panel pins it to the left edge", () => {
    expect(clampHudPosition({ left: 200, top: 100 }, SIZE, { width: 250, height: 600 })).toEqual({ left: 8, top: 100 });
  });
});
