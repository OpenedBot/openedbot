import { describe, expect, test } from "bun:test";

import { classifyLocalEnvEntry, parseEnvEntries } from "./env-file";

describe("classifyLocalEnvEntry", () => {
  test("keeps local variables and unknown ones", () => {
    expect(classifyLocalEnvEntry({ name: "API_DATABASE_URL", value: "postgres://x" }, "external")).toBe("keep");
    expect(classifyLocalEnvEntry({ name: "CUSTOM_UNKNOWN", value: "1" }, "external")).toBe("keep");
  });

  test("removes empty production or default-only variables, preserves non-empty ones", () => {
    expect(classifyLocalEnvEntry({ name: "API_PUBLIC_URL", value: "" }, "external")).toBe("remove");
    expect(classifyLocalEnvEntry({ name: "WORKER_INTERNAL_TOKEN", value: "x" }, "external")).toBe("preserve");
  });

  test("removes deprecated runtime variables", () => {
    expect(classifyLocalEnvEntry({ name: "DEV_BUNDLED_HERMES_TOKEN", value: "x" }, "external")).toBe("remove");
  });

  test("removes a runtime admin mode other than disabled", () => {
    expect(classifyLocalEnvEntry({ name: "OHB_RUNTIME_ADMIN_MODE", value: "local" }, "external")).toBe("remove");
    expect(classifyLocalEnvEntry({ name: "OHB_RUNTIME_ADMIN_MODE", value: "disabled" }, "external")).not.toBe("remove");
  });
});

describe("parseEnvEntries", () => {
  test("keeps order and ignores comments", () => {
    const entries = parseEnvEntries("# c\nA=1\n\nB=two words\n");
    expect(entries.map((e) => e.name)).toEqual(["A", "B"]);
    expect(entries[1]?.value).toBe("two words");
  });
});

describe("classifyLocalEnvEntry: plug-in variables", () => {
  test("a set OHB_PRO_<ID>__<KEY> is preserved, an empty one removed", () => {
    expect(classifyLocalEnvEntry({ name: "OHB_PRO_BILLING__API_KEY", value: "x" }, "external")).toBe("preserve");
    expect(classifyLocalEnvEntry({ name: "OHB_PRO_BILLING__API_KEY", value: "" }, "external")).toBe("remove");
  });
});
