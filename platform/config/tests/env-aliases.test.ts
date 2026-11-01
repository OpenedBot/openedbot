import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEnvAliases, ENV_MERGES, ENV_RENAMES, mergedEnvTarget, renamedEnvName, resetEnvAliasWarnings } from "../src/env-aliases";
import { envSchemaEntry } from "../src/env-schema";

const root = join(import.meta.dir, "..", "..", "..");

describe("OHB_* -> OPENEDBOT_* one-release fallback", () => {
  beforeEach(() => resetEnvAliasWarnings());

  test("copies an old name to its unset new name, once, with a warning naming no value", () => {
    const env: Record<string, string | undefined> = { OHB_ENV: "production", OHB_PRO_AUDIT__RETENTION_DAYS: "30" };
    const warnings: string[] = [];
    applyEnvAliases(env, (message) => warnings.push(message));
    expect(env.OPENEDBOT_ENV).toBe("production");
    expect(env.OPENEDBOT_PLUGIN_AUDIT__RETENTION_DAYS).toBe("30");
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).not.toContain("production");
    applyEnvAliases(env, (message) => warnings.push(message));
    expect(warnings).toHaveLength(2);
  });

  test("the new name wins when both are set", () => {
    const env: Record<string, string | undefined> = { OHB_LOG_DIR: "/old", OPENEDBOT_LOG_DIR: "/new" };
    const warnings: string[] = [];
    applyEnvAliases(env, (message) => warnings.push(message));
    expect(env.OPENEDBOT_LOG_DIR).toBe("/new");
    expect(warnings[0]).toContain("OPENEDBOT_LOG_DIR wins");
  });

  test("exact names before the plug-in prefix", () => {
    expect(renamedEnvName("OHB_PRO_PLUGINS")).toBe("OPENEDBOT_PLUGINS");
    expect(renamedEnvName("OHB_PRO_CONSOLE")).toBe("OPENEDBOT_CONSOLE_PLUGINS");
    expect(renamedEnvName("OHB_PRO_BILLING__API_KEY")).toBe("OPENEDBOT_PLUGIN_BILLING__API_KEY");
    expect(renamedEnvName("OPENEDBOT_ENV")).toBeUndefined();
    expect(renamedEnvName("OHB_GOOGLE_CLIENT_ID")).toBeUndefined();
  });

  test("every new name of the table is new-style, and no old name is still declared", () => {
    // A few names leave the prefix for the plain name the tools already use.
    const unprefixed = new Set(["ENV_FILE", "E2E_MAILPIT_URL"]);
    for (const [old, next] of Object.entries(ENV_RENAMES)) {
      expect([old, next.startsWith("OPENEDBOT_") || unprefixed.has(next)]).toEqual([old, true]);
      expect([old, envSchemaEntry(old)]).toEqual([old, undefined]);
    }
  });

  test("the shell table (scripts/lib/env-aliases.sh) is the same table", () => {
    const sh = readFileSync(join(root, "scripts/lib/env-aliases.sh"), "utf8");
    const block = sh.split("<<'TABLE'\n")[1]?.split("\nTABLE")[0] ?? "";
    const pairs = Object.fromEntries(block.trim().split("\n").map((line) => line.trim().split(/\s+/) as [string, string]));
    expect(pairs).toEqual({ ...ENV_RENAMES });
  });

  test("merged names: converted into their target, then removed, one warning naming no value", () => {
    const warnings: string[] = [];
    const preprod: Record<string, string | undefined> = { OHB_ENV: "production", OHB_DEPLOY_ENV: "preprod" }; // rename:keep
    applyEnvAliases(preprod, (message) => warnings.push(message));
    expect(preprod).toEqual({ OHB_ENV: "production", OPENEDBOT_ENV: "preprod" }); // rename:keep
    expect(warnings.some((message) => message.includes("folded into OPENEDBOT_ENV"))).toBe(true);
    expect(warnings.join("\n")).not.toContain("preprod");
    resetEnvAliasWarnings();
    const prod: Record<string, string | undefined> = { OPENEDBOT_ENV: "production", OHB_DEPLOY_ENV: "prod" }; // rename:keep
    applyEnvAliases(prod, () => {});
    expect(prod).toEqual({ OPENEDBOT_ENV: "production" });
  });

  test("every merged name is an old name, and its target is declared", () => {
    for (const merge of ENV_MERGES) {
      for (const name of merge.from) {
        expect([name, name.startsWith("OHB_"), renamedEnvName(name)]).toEqual([name, true, undefined]);
        expect(mergedEnvTarget(name)).toBe(merge.into);
      }
      expect([merge.into, envSchemaEntry(merge.into)?.name]).toEqual([merge.into, merge.into]);
    }
  });

  test("the four Cloudflare names fold into one managed tunnel URL that reads back", async () => {
    const { readManagedTunnelConfig } = await import("@openedbot/platform-integrations/managed-tunnel");
    const env: Record<string, string | undefined> = { OHB_CF_ACCOUNT_ID: "acc", OHB_CF_API_TOKEN: "t/k", OHB_CF_ZONE_ID: "zone", OHB_MANAGED_TUNNEL_SUFFIX: "example.test" }; // rename:keep
    const warnings: string[] = [];
    applyEnvAliases(env, (message) => warnings.push(message));
    expect(Object.keys(env)).toEqual(["OPENEDBOT_MANAGED_TUNNEL_URL"]);
    expect(readManagedTunnelConfig(env)).toEqual({ accountId: "acc", apiToken: "t/k", zoneId: "zone", hostSuffix: "example.test" });
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).not.toContain("t/k");
    resetEnvAliasWarnings();
    const partial: Record<string, string | undefined> = { OHB_CF_ACCOUNT_ID: "acc" }; // rename:keep
    applyEnvAliases(partial, () => {});
    expect(partial).toEqual({});
  });

  test("the Computer provider: box keeps the token, an explicit disabled unsets it", () => {
    const box: Record<string, string | undefined> = { OHB_COMPUTER_PROVIDER: "box", OHB_COMPUTER_BOX_TOKEN: "tok" }; // rename:keep
    applyEnvAliases(box, () => {});
    expect(box).toEqual({ OHB_COMPUTER_BOX_TOKEN: "tok", OPENEDBOT_COMPUTER_BOX_TOKEN: "tok" }); // rename:keep
    resetEnvAliasWarnings();
    const off: Record<string, string | undefined> = { OHB_COMPUTER_PROVIDER: "disabled", OPENEDBOT_COMPUTER_BOX_TOKEN: "tok" }; // rename:keep
    applyEnvAliases(off, () => {});
    expect(off).toEqual({});
  });

  test("OHB_LOG_TO_FILES=0 becomes OPENEDBOT_LOG_DIR=off; any other value changes nothing", () => {
    const off: Record<string, string | undefined> = { OHB_LOG_TO_FILES: "0", OHB_LOG_DIR: "/var/log/x" }; // rename:keep
    applyEnvAliases(off, () => {});
    expect(off.OPENEDBOT_LOG_DIR).toBe("off");
    expect("OHB_LOG_TO_FILES" in off).toBe(false); // rename:keep
    resetEnvAliasWarnings();
    const on: Record<string, string | undefined> = { OHB_LOG_TO_FILES: "1" }; // rename:keep
    applyEnvAliases(on, () => {});
    expect(on).toEqual({});
  });

  test("OHB_CONSOLE_SOLO=1 becomes OPENEDBOT_CONSOLE_MODE=solo", () => {
    const env: Record<string, string | undefined> = { OHB_CONSOLE_SOLO: "1" }; // rename:keep
    applyEnvAliases(env, () => {});
    expect(env).toEqual({ OPENEDBOT_CONSOLE_MODE: "solo" });
  });

  test("the database name and port copies are ignored: API_DATABASE_URL carries them", () => {
    const warnings: string[] = [];
    const env: Record<string, string | undefined> = { OHB_DATABASE_NAME: "ohb", OHB_POSTGRES_PORT: "5433" }; // rename:keep
    applyEnvAliases(env, (message) => warnings.push(message));
    expect(env.OPENEDBOT_DATABASE_NAME).toBeUndefined();
    expect(warnings.join("\n")).toContain("comes from API_DATABASE_URL");
    expect(warnings.join("\n")).not.toContain("5433");
  });
});
