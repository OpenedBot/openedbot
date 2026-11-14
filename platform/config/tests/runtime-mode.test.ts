import { describe, expect, test } from "bun:test";
import { isRuntimeMode, RUNTIME_MODE } from "../src/runtime-mode";

describe("runtime mode", () => {
  test("is always external", () => {
    expect(RUNTIME_MODE).toBe("external");
  });

  test("isRuntimeMode narrows unknown input", () => {
    expect(isRuntimeMode("external")).toBe(true);
    expect(isRuntimeMode(null)).toBe(false);
    expect(isRuntimeMode("local")).toBe(false);
  });
});
