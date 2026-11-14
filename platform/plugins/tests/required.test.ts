import { describe, expect, test } from "bun:test";
import {
  assertRequiredPlugins,
  missingRequiredPlugins,
  parseRequiredPlugins,
  PLUGIN_API_VERSION,
  RequiredPluginsMissingError,
  REQUIRED_PLUGINS_ENV,
  type ProPlugin,
} from "../src";

const plugin = (id: string): ProPlugin => ({ manifest: { id, version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] } });

describe("OPENEDBOT_REQUIRED_PLUGINS", () => {
  test("empty or unset requires nothing: solo stays permissive", () => {
    for (const value of [undefined, "", " ", " , ,"]) expect(parseRequiredPlugins(value)).toEqual([]);
    expect(() => assertRequiredPlugins({}, [])).not.toThrow();
    expect(() => assertRequiredPlugins({ [REQUIRED_PLUGINS_ENV]: "" }, [])).not.toThrow();
  });

  test("ids are trimmed and deduplicated; a malformed id throws instead of requiring nothing", () => {
    expect(parseRequiredPlugins(" audit , permissions,audit ")).toEqual(["audit", "permissions"]);
    expect(() => parseRequiredPlugins("audit,@openedbot/pro-audit")).toThrow(/is not a plug-in id/);
    expect(() => parseRequiredPlugins("Audit")).toThrow(/is not a plug-in id/);
  });

  test("names every required id that is not kept, in order", () => {
    expect(missingRequiredPlugins(["audit", "permissions", "billing"], [plugin("billing")])).toEqual(["audit", "permissions"]);
    expect(missingRequiredPlugins(["audit"], [plugin("audit"), plugin("permissions")])).toEqual([]);
  });

  test("the error names the missing ids and why the loader skipped what it skipped", () => {
    let caught: unknown;
    try {
      assertRequiredPlugins({ [REQUIRED_PLUGINS_ENV]: "audit,permissions" }, [plugin("permissions")], [
        { specifier: "@openedbot/pro-audit", reason: "cannot import: Cannot find module" },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RequiredPluginsMissingError);
    expect((caught as RequiredPluginsMissingError).missing).toEqual(["audit"]);
    expect((caught as Error).message).toBe(
      "OPENEDBOT_REQUIRED_PLUGINS requires plug-in(s) that are not loaded: audit. Skipped at load: @openedbot/pro-audit (cannot import: Cannot find module).",
    );
    expect(() => assertRequiredPlugins({ [REQUIRED_PLUGINS_ENV]: "audit,permissions" }, [plugin("audit"), plugin("permissions")])).not.toThrow();
  });
});
