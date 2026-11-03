import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENV_MERGES,
  ENV_RENAMES,
  foldEnvMerges,
  legacyEnvRefusal,
  mergedEnvTarget,
  renamedEnvName,
  resetDerivedEnvWarnings,
  warnDerivedEnv,
} from "../src/legacy-env";
import { envSchemaEntry } from "../src/env-schema";

const root = join(import.meta.dir, "..", "..", "..");

describe("retired OHB_* names: refused, never read", () => {
  beforeEach(() => resetDerivedEnvWarnings());

  test("no retired name, no refusal", () => {
    expect(legacyEnvRefusal({ OPENEDBOT_ENV: "production", HOME: "/home/x" })).toBeNull();
  });

  test("each retired name is named with its successor, sorted, and no value ever appears", () => {
    const env = {
      OHB_ENV: "production-secret",
      OHB_PRO_AUDIT__RETENTION_DAYS: "30",
      OHB_CF_API_TOKEN: "cf-token-value",
      OHB_GOOGLE_CLIENT_ID: "google-id",
      OHB_DATABASE_NAME: "dbname",
      OPENEDBOT_LOG_DIR: "/var/log/x",
    };
    const refusal = legacyEnvRefusal(env)!;
    expect(refusal.split("\n")).toEqual([
      "openedbot refuses to start: these variables use the retired OHB_ prefix and are no longer read.",
      "  OHB_CF_API_TOKEN: folded into OPENEDBOT_MANAGED_TUNNEL_URL: set OPENEDBOT_MANAGED_TUNNEL_URL instead",
      "  OHB_DATABASE_NAME: retired, its value comes from API_DATABASE_URL: remove it",
      "  OHB_ENV: rename it to OPENEDBOT_ENV",
      "  OHB_GOOGLE_CLIENT_ID: retired: remove it",
      "  OHB_PRO_AUDIT__RETENTION_DAYS: rename it to OPENEDBOT_PLUGIN_AUDIT__RETENTION_DAYS",
      "Fix them where the environment is defined (shell, env file, secret, compose file). In a checkout, `make env-prune` rewrites .env.local under the new names, values kept.",
    ]);
    for (const value of Object.values(env)) expect(refusal).not.toContain(value);
    // Nothing is copied: the old names are not read.
    expect(env).not.toHaveProperty("OPENEDBOT_ENV");
  });

  test("the guard stops an entry point with EX_CONFIG before it reads anything", () => {
    const run = (extra: Record<string, string>) =>
      Bun.spawnSync(["bun", "-e", 'await import("@openedbot/platform-config/legacy-env-guard"); console.log("started")'], {
        cwd: join(root, "apps", "api"),
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra },
      });
    const refused = run({ OHB_ENV: "do-not-print" });
    expect(refused.exitCode).toBe(78);
    expect(refused.stdout.toString()).toBe("");
    expect(refused.stderr.toString()).toContain("OHB_ENV: rename it to OPENEDBOT_ENV");
    expect(refused.stderr.toString()).not.toContain("do-not-print");
    const clean = run({});
    expect([clean.exitCode, clean.stdout.toString().trim()]).toEqual([0, "started"]);
  });

  test("the shell guard refuses the same names and exits 78; a clean environment passes", () => {
    const sh = (extra: Record<string, string>) =>
      Bun.spawnSync(["bash", "-c", '. scripts/lib/legacy-env.sh; echo passed'], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", ...extra },
      });
    const refused = sh({ OHB_ENV: "do-not-print", OHB_PRO_BILLING__API_KEY: "k", OHB_LOG_TO_FILES: "0" });
    expect(refused.exitCode).toBe(78);
    expect(refused.stdout.toString()).toBe("");
    const stderr = refused.stderr.toString();
    expect(stderr).toContain("  OHB_ENV: rename it to OPENEDBOT_ENV");
    expect(stderr).toContain("  OHB_PRO_BILLING__API_KEY: rename it to OPENEDBOT_PLUGIN_BILLING__API_KEY");
    expect(stderr).toContain("  OHB_LOG_TO_FILES: folded into OPENEDBOT_LOG_DIR");
    expect(stderr).not.toContain("do-not-print");
    const clean = sh({});
    expect([clean.exitCode, clean.stdout.toString().trim()]).toEqual([0, "passed"]);
  });

  test("the Makefile refuses a retired name from the environment or the command line", () => {
    const make = (args: string[], extra: Record<string, string> = {}) =>
      Bun.spawnSync(["make", "--no-print-directory", "-n", "help", ...args], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra },
      });
    for (const result of [make([], { OHB_PUBLIC_URL: "https://x.test" }), make(["OHB_CORE_DIR=/tmp/x"])]) {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("the retired OHB_ prefix is no longer read: OHB_");
      expect(result.stderr.toString()).not.toContain("x.test");
    }
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

  test("the shell table (scripts/lib/legacy-env.sh) is the same table, merged names included", () => {
    const sh = readFileSync(join(root, "scripts/lib/legacy-env.sh"), "utf8");
    const block = sh.split("<<'TABLE'\n")[1]?.split("\nTABLE")[0] ?? "";
    const pairs = Object.fromEntries(block.trim().split("\n").map((line) => line.trim().split(/\s+/) as [string, string]));
    expect(pairs).toEqual({ ...ENV_RENAMES });
    for (const merge of ENV_MERGES) {
      for (const name of merge.from) expect([name, sh.includes(name) && sh.includes(`folded into ${merge.into}`)]).toEqual([name, true]);
    }
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
});

// The merges are what `env-audit --apply` writes into an env file: their
// conversions are checked on a plain object, the way it uses them.
describe("env-audit conversions of the merged names", () => {
  test("OHB_DEPLOY_ENV=preprod on production rules becomes OPENEDBOT_ENV=preprod", () => {
    const preprod: Record<string, string | undefined> = { OPENEDBOT_ENV: "production", OHB_DEPLOY_ENV: "preprod" };
    foldEnvMerges(preprod);
    expect(preprod).toEqual({ OPENEDBOT_ENV: "preprod" });
    const prod: Record<string, string | undefined> = { OPENEDBOT_ENV: "production", OHB_DEPLOY_ENV: "prod" };
    foldEnvMerges(prod);
    expect(prod).toEqual({ OPENEDBOT_ENV: "production" });
  });

  test("the four Cloudflare names fold into one managed tunnel URL that reads back", async () => {
    const { readManagedTunnelConfig } = await import("@openedbot/platform-integrations/managed-tunnel");
    const env: Record<string, string | undefined> = { OHB_CF_ACCOUNT_ID: "acc", OHB_CF_API_TOKEN: "t/k", OHB_CF_ZONE_ID: "zone", OHB_MANAGED_TUNNEL_SUFFIX: "example.test" };
    expect(foldEnvMerges(env)).toHaveLength(4);
    expect(Object.keys(env)).toEqual(["OPENEDBOT_MANAGED_TUNNEL_URL"]);
    expect(readManagedTunnelConfig(env)).toEqual({ accountId: "acc", apiToken: "t/k", zoneId: "zone", hostSuffix: "example.test" });
    const partial: Record<string, string | undefined> = { OHB_CF_ACCOUNT_ID: "acc" };
    foldEnvMerges(partial);
    expect(partial).toEqual({});
  });

  test("the Computer provider: box keeps the token, an explicit disabled unsets it", () => {
    const box: Record<string, string | undefined> = { OHB_COMPUTER_PROVIDER: "box", OPENEDBOT_COMPUTER_BOX_TOKEN: "tok" };
    foldEnvMerges(box);
    expect(box).toEqual({ OPENEDBOT_COMPUTER_BOX_TOKEN: "tok" });
    const off: Record<string, string | undefined> = { OHB_COMPUTER_PROVIDER: "disabled", OPENEDBOT_COMPUTER_BOX_TOKEN: "tok" };
    foldEnvMerges(off);
    expect(off).toEqual({});
  });

  test("OHB_LOG_TO_FILES=0 becomes OPENEDBOT_LOG_DIR=off; OHB_CONSOLE_SOLO=1 becomes OPENEDBOT_CONSOLE_MODE=solo", () => {
    const off: Record<string, string | undefined> = { OHB_LOG_TO_FILES: "0" };
    foldEnvMerges(off);
    expect(off).toEqual({ OPENEDBOT_LOG_DIR: "off" });
    const on: Record<string, string | undefined> = { OHB_LOG_TO_FILES: "1" };
    foldEnvMerges(on);
    expect(on).toEqual({});
    const solo: Record<string, string | undefined> = { OHB_CONSOLE_SOLO: "1" };
    foldEnvMerges(solo);
    expect(solo).toEqual({ OPENEDBOT_CONSOLE_MODE: "solo" });
  });
});

describe("OPENEDBOT_ names that no longer carry their own value", () => {
  beforeEach(() => resetDerivedEnvWarnings());

  test("the database name and port copies are warned about once, never with a value", () => {
    const warnings: string[] = [];
    const env = { OPENEDBOT_DATABASE_NAME: "ohb", OPENEDBOT_POSTGRES_PORT: "5433" };
    warnDerivedEnv(env, (message) => warnings.push(message));
    warnDerivedEnv(env, (message) => warnings.push(message));
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("comes from API_DATABASE_URL");
    expect(warnings.join("\n")).not.toContain("5433");
  });
});
