import { describe, expect, test } from "bun:test";

import { classifyLocalEnvEntry, parseEnvEntries, withRenamedEnvValues } from "./env-file";

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

  test("removes the dropped runtime variables, whatever their value", () => {
    for (const value of ["local", "disabled", "external"]) {
      expect(classifyLocalEnvEntry({ name: "OHB_RUNTIME_ADMIN_MODE", value }, "external")).toBe("remove"); // rename:keep
      expect(classifyLocalEnvEntry({ name: "OHB_RUNTIME_MODE", value }, "external")).toBe("remove"); // rename:keep
    }
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
  test("a set OPENEDBOT_PLUGIN_<ID>__<KEY> is preserved, an empty one removed", () => {
    expect(classifyLocalEnvEntry({ name: "OPENEDBOT_PLUGIN_BILLING__API_KEY", value: "x" }, "external")).toBe("preserve");
    expect(classifyLocalEnvEntry({ name: "OPENEDBOT_PLUGIN_BILLING__API_KEY", value: "" }, "external")).toBe("remove");
  });
});

describe("OHB_* -> OPENEDBOT_* rename (one release)", () => {
  test("an old name is renamed, never removed, even when empty", () => {
    expect(classifyLocalEnvEntry({ name: "OHB_DATABASE_NAME", value: "ohb" }, "external")).toBe("rename"); // rename:keep
    expect(classifyLocalEnvEntry({ name: "OHB_CF_API_TOKEN", value: "" }, "external")).toBe("rename"); // rename:keep
    expect(classifyLocalEnvEntry({ name: "OHB_PRO_BILLING__API_KEY", value: "x" }, "external")).toBe("rename"); // rename:keep
  });

  test("a retired OHB_* name is still removed", () => {
    expect(classifyLocalEnvEntry({ name: "OHB_GOOGLE_CLIENT_ID", value: "x" }, "external")).toBe("remove");
  });

  test("the values fold into the new names, the new name winning", () => {
    expect(withRenamedEnvValues({ OHB_DATABASE_NAME: "a", OHB_ENV: "test", OPENEDBOT_ENV: "development", X: "1" })).toEqual({ // rename:keep
      OPENEDBOT_DATABASE_NAME: "a",
      OPENEDBOT_ENV: "development",
      X: "1",
    });
  });
});
