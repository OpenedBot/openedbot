import { describe, expect, test } from "bun:test";
import { isRuntimeMode, readRuntimeMode } from "../src/runtime-mode";

describe("readRuntimeMode: the single OHB_RUNTIME_MODE parser", () => {
  test("always defaults to external", () => {
    expect(readRuntimeMode(undefined, "development")).toBe("external");
    expect(readRuntimeMode("  ", "development")).toBe("external");
    expect(readRuntimeMode(undefined, "test")).toBe("external");
    expect(readRuntimeMode("", "production")).toBe("external");
  });

  test("accepts the external value", () => {
    expect(readRuntimeMode(" external ", "development")).toBe("external");
  });

  test("refuses any other value", () => {
    expect(readRuntimeMode("ssh", "development")).toBe("external");
  });

  test("isRuntimeMode narrows unknown input", () => {
    expect(isRuntimeMode("external")).toBe(true);
    expect(isRuntimeMode(null)).toBe(false);
    expect(isRuntimeMode("local")).toBe(false);
  });
});
