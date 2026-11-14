import { describe, expect, test } from "bun:test";
import { readRuntimeEnvironment } from "../src/deploy-environment";

describe("readRuntimeEnvironment", () => {
  test("maps the four accepted values, preprod on production rules", () => {
    expect(readRuntimeEnvironment("production")).toBe("production");
    expect(readRuntimeEnvironment("preprod")).toBe("production");
    expect(readRuntimeEnvironment("test")).toBe("test");
    expect(readRuntimeEnvironment(" development ")).toBe("development");
  });

  test("absent or empty means development", () => {
    expect(readRuntimeEnvironment(undefined)).toBe("development");
    expect(readRuntimeEnvironment("  ")).toBe("development");
  });

  test("refuses any other value, naming the variable", () => {
    expect(() => readRuntimeEnvironment("prod")).toThrow('OPENEDBOT_ENV must be one of development, test, production, preprod (got "prod").');
    expect(() => readRuntimeEnvironment("PRODUCTION", "NODE_ENV")).toThrow(/^NODE_ENV must be one of/);
  });
});
