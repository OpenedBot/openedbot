import { describe, expect, test } from "bun:test";
import type { Db } from "@openedbot/platform-db";
import { PLUGIN_API_VERSION, type ProPlugin } from "@openedbot/platform-plugins";
import { loadGatewayAuditArchive } from "../src/audit-archive";

const db = {} as Db;
const archive = { id: "worm:r2", put: async () => undefined, get: async () => null };
const audit: ProPlugin = {
  manifest: {
    id: "audit", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: ["audit.anchor"],
    env: [{ name: "AUDIT_WORM_BUCKET", requiredInProduction: true }],
  },
  auditArchive: archive,
};

function options(env: Record<string, string | undefined>, extra: Partial<Parameters<typeof loadGatewayAuditArchive>[0]> = {}) {
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return {
    logs,
    value: {
      env, production: false, db,
      log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); },
      importer: async (specifier: string) => {
        if (specifier === "audit") return audit;
        throw new Error(`Cannot find module '${specifier}'`);
      },
      roleProblem: async () => null,
      ...extra,
    },
  };
}

describe("link gateway: the audit archive port", () => {
  test("solo (OPENEDBOT_PLUGINS empty or unset): no archive, nothing imported", async () => {
    let imported = false;
    for (const env of [{}, { OPENEDBOT_PLUGINS: "" }, { OPENEDBOT_PLUGINS: " , " }]) {
      const { value } = options(env, { importer: async () => { imported = true; return audit; } });
      expect(await loadGatewayAuditArchive(value)).toBeNull();
    }
    expect(imported).toBe(false);
  });

  test("the plug-in audit installs its archive", async () => {
    const { value, logs } = options({ OPENEDBOT_PLUGINS: "audit" });
    expect(await loadGatewayAuditArchive(value)).toBe(archive);
    expect(logs).toContainEqual({ event: "runtime_link.audit_archive", fields: { archive: "worm:r2" } });
  });

  test("a plug-in that cannot be loaded is skipped: no archive, the gateway starts", async () => {
    const { value, logs } = options({ OPENEDBOT_PLUGINS: "missing" });
    expect(await loadGatewayAuditArchive(value)).toBeNull();
    expect(logs[0]?.event).toBe("runtime_link.pro_plugin_skipped");
  });

  test("production: a loaded plug-in missing a required variable prevents startup", async () => {
    const { value } = options({ OPENEDBOT_PLUGINS: "audit" }, { production: true });
    await expect(loadGatewayAuditArchive(value)).rejects.toThrow(/audit: AUDIT_WORM_BUCKET/);
    const { value: complete } = options({ OPENEDBOT_PLUGINS: "audit", AUDIT_WORM_BUCKET: "bucket" }, { production: true });
    expect(await loadGatewayAuditArchive(complete)).toBe(archive);
  });

  test("OPENEDBOT_REQUIRED_PLUGINS: the gateway refuses to start without a required plug-in, and names it", async () => {
    for (const env of [{ OPENEDBOT_REQUIRED_PLUGINS: "audit" }, { OPENEDBOT_PLUGINS: "missing", OPENEDBOT_REQUIRED_PLUGINS: "audit,permissions" }]) {
      const { value, logs } = options(env);
      await expect(loadGatewayAuditArchive(value)).rejects.toThrow(/OPENEDBOT_REQUIRED_PLUGINS requires plug-in\(s\) that are not loaded: audit/);
      expect(logs.find((entry) => entry.event === "runtime_link.required_plugins_missing")?.fields.missing).toEqual(
        env.OPENEDBOT_PLUGINS ? ["audit", "permissions"] : ["audit"],
      );
    }
    const { value: refused } = options({ OPENEDBOT_PLUGINS: "audit", OPENEDBOT_REQUIRED_PLUGINS: "audit" }, { roleProblem: async () => "superuser" });
    await expect(loadGatewayAuditArchive(refused)).rejects.toThrow(/not loaded: audit/);
    const { value: kept } = options({ OPENEDBOT_PLUGINS: "audit", OPENEDBOT_REQUIRED_PLUGINS: "audit" });
    expect(await loadGatewayAuditArchive(kept)).toBe(archive);
  });

  test("a pool role outside row-level security installs no archive", async () => {
    const { value, logs } = options({ OPENEDBOT_PLUGINS: "audit" }, { roleProblem: async () => "superuser" });
    expect(await loadGatewayAuditArchive(value)).toBeNull();
    expect(logs).toContainEqual({ event: "runtime_link.pro_plugins_refused", fields: { reason: "superuser" } });
  });
});
