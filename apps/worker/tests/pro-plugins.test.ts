import { describe, expect, test } from "bun:test";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { PLUGIN_API_VERSION, type ProPlugin } from "@openedbot/platform-plugins";
import { assertWorkerProPluginProductionEnv, loadWorkerPro, proJobs, tenantDeletingHooks } from "../src/application/pro-plugins";

const plugin = (id: string, extra: Partial<ProPlugin> = {}, entitlements: string[] = []): ProPlugin => ({
  manifest: { id, version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements },
  ...extra,
});
const importerFor = (modules: Record<string, unknown>) => async (specifier: string) => {
  if (!(specifier in modules)) throw new Error(`Cannot find module '${specifier}'`);
  return modules[specifier];
};
const silent = { skipped: () => undefined, refused: () => undefined };

/** The pool role as the guard reads it: a plain role that owns nothing. */
function roleDb(queries: string[], facts: { superuser?: boolean } = {}) {
  const tag = async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    queries.push(sql);
    if (sql.includes("pg_roles")) return [{ role: "ohb_worker", superuser: facts.superuser ?? false, bypassRls: false, ownsTables: false, current: true }];
    return [];
  };
  return tag as unknown as Db;
}
const noQueryDb = (async () => { throw new Error("solo must not query"); }) as unknown as Db;

describe("loadWorkerPro", () => {
  test("solo: no plug-in, no query, and never billing.enforced, even with BILLING_ENFORCED (step 8d)", async () => {
    for (const billingEnforced of [false, true]) {
      const pro = await loadWorkerPro({}, noQueryDb, { billingEnforced }, silent);
      expect(pro.plugins).toEqual([]);
      expect(pro.billingEnforced).toBe(false);
      expect(pro.tenantDeleting).toBeNull();
      expect(pro.subscriptions).toBeNull();
    }
  });

  test("the subscription port is the plug-in billing's (step 8d), never another id's", async () => {
    const port = { memberLimit: async () => 3, status: async () => null, read: async () => null, readForUpdate: async () => null, admission: () => null };
    const billing = { webhookPath: "/api/pay/webhook", webhook: async () => new Response(null), subscriptions: port };
    const withBilling = await loadWorkerPro({ OHB_PRO_PLUGINS: "billing" }, roleDb([]), { billingEnforced: true }, silent, {
      importer: importerFor({ billing: plugin("billing", { billing }, ["billing.enforced"]) }),
    });
    expect(withBilling.subscriptions as unknown).toBe(port);
    const without = await loadWorkerPro({ OHB_PRO_PLUGINS: "billing" }, roleDb([]), { billingEnforced: true }, silent, {
      importer: importerFor({ billing: plugin("billing", {}, ["billing.enforced"]) }),
    });
    expect(without.subscriptions).toBeNull();
  });

  test("the plug-in billing provides billing.enforced; BILLING_ENFORCED still decides it", async () => {
    for (const billingEnforced of [false, true]) {
      const queries: string[] = [];
      const pro = await loadWorkerPro({ OHB_PRO_PLUGINS: "billing" }, roleDb(queries), { billingEnforced }, silent, {
        importer: importerFor({ billing: plugin("billing", {}, ["billing.enforced"]) }),
      });
      expect(pro.plugins.map((loaded) => loaded.manifest.id)).toEqual(["billing"]);
      expect(pro.billingEnforced).toBe(billingEnforced);
      expect(await pro.entitlements.has("billing.enforced")).toBe(billingEnforced);
      expect(queries.length).toBeGreaterThan(0);
    }
  });

  test("a pool role that bypasses row-level security drops every plug-in", async () => {
    const refused: string[] = [];
    const pro = await loadWorkerPro({ OHB_PRO_PLUGINS: "billing" }, roleDb([], { superuser: true }), { billingEnforced: false }, {
      ...silent,
      refused: (reason) => refused.push(reason),
    }, { importer: importerFor({ billing: plugin("billing", { hooks: { onTenantDeleting: async () => undefined } }, ["billing.enforced"]) }) });
    expect(pro.plugins).toEqual([]);
    expect(pro.billingEnforced).toBe(false);
    expect(pro.tenantDeleting).toBeNull();
    expect(refused).toHaveLength(1);
  });
});

describe("tenantDeletingHooks", () => {
  const tx = {} as TransactionDb;
  const event = { organizationId: "org-1", reason: "tenant_deleted" };

  test("null without any hook", () => {
    expect(tenantDeletingHooks([plugin("agency")])).toBeNull();
  });

  test("runs the hooks in load order; the first failure stops and names the plug-in", async () => {
    const calls: string[] = [];
    const hooks = tenantDeletingHooks([
      plugin("agency", { hooks: { onTenantDeleting: async (_tx, received) => { calls.push(`agency:${received.organizationId}`); } } }),
      plugin("billing", { hooks: { onTenantDeleting: async () => { calls.push("billing"); throw new Error("keep failed"); } } }),
      plugin("third", { hooks: { onTenantDeleting: async () => { calls.push("third"); } } }),
    ])!;
    await expect(hooks(tx, event)).rejects.toThrow("plug-in billing: keep failed");
    expect(calls).toEqual(["agency:org-1", "billing"]);
  });

  test("each hook receives only its own plug-in configuration (OHB_PRO_<ID>__<KEY>)", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = [];
    const hooks = tenantDeletingHooks([
      plugin("audit", { hooks: { onTenantDeleting: async (_tx, _event, context) => { seen.push(context?.config); } } }),
      plugin("billing", { hooks: { onTenantDeleting: async (_tx, _event, context) => { seen.push(context?.config); } } }),
    ], { OHB_PRO_AUDIT__RETENTION_DAYS: "3650", OHB_PRO_BILLING__API_KEY: "x", DATABASE_URL: "postgres://" })!;
    await hooks(tx, event);
    expect(seen).toEqual([{ RETENTION_DAYS: "3650" }, { API_KEY: "x" }]);
  });
});

describe("proJobs", () => {
  test("solo: no job; loadWorkerPro exposes none", async () => {
    expect(proJobs([], noQueryDb)).toEqual([]);
    expect((await loadWorkerPro({}, noQueryDb, { billingEnforced: false }, silent)).jobs).toEqual([]);
  });

  test("an enabled job runs with the worker pool, its own configuration and the shutdown signal", async () => {
    const calls: Array<{ db: unknown; config: Readonly<Record<string, string>>; aborted: boolean }> = [];
    const pool = { pool: true };
    const jobs = proJobs([
      plugin("audit", { jobs: [{ name: "purge-expired", everyMs: 3_600_000, run: async (db, context) => {
        calls.push({ db, config: context.config, aborted: context.signal.aborted });
      } }] }),
    ], pool, { OHB_PRO_AUDIT__RETENTION_DAYS: "30", OHB_PRO_BILLING__KEY: "other plug-in" });
    expect(jobs.map((job) => [job.name, job.everyMs])).toEqual([["pro:audit:purge-expired", 3_600_000]]);
    await jobs[0]!.run(new AbortController().signal);
    expect(calls).toEqual([{ db: pool, config: { RETENTION_DAYS: "30" }, aborted: false }]);
  });

  test("enabled() false or throwing: not scheduled, reported once with its reason", async () => {
    const disabled: Array<{ name: string; reason: string }> = [];
    const run = async () => { throw new Error("must not run"); };
    const jobs = proJobs([
      plugin("audit", { jobs: [
        { name: "purge-expired", everyMs: 3_600_000, enabled: (context) => context.config.RETENTION_DAYS !== undefined, run },
        { name: "broken", everyMs: 3_600_000, enabled: () => { throw new Error("bad config"); }, run },
      ] }),
    ], noQueryDb, {}, (job) => disabled.push(job));
    expect(jobs).toEqual([]);
    expect(disabled).toEqual([
      { name: "pro:audit:purge-expired", reason: "disabled by its configuration" },
      { name: "pro:audit:broken", reason: "enabled() failed: bad config" },
    ]);
  });
});

describe("production deployment variables (step 11.5)", () => {
  const PAY = [{ name: "PAY_SECRET", requiredInProduction: true }, { name: "PAY_PRICE", requiredInProduction: true }, { name: "PAY_REGION" }];
  const payingBilling = () => {
    const base = plugin("billing", {}, ["billing.enforced"]);
    return { ...base, manifest: { ...base.manifest, env: PAY } } as ProPlugin;
  };
  const MESSAGE = "Required in production by the loaded plug-ins: billing: PAY_SECRET, billing: PAY_PRICE.";

  test("solo production requires nothing and runs no query", async () => {
    const pro = await loadWorkerPro({}, noQueryDb, { billingEnforced: true, environment: "production" }, silent);
    expect(pro.plugins).toEqual([]);
    expect(() => assertWorkerProPluginProductionEnv([], {})).not.toThrow();
  });

  test("billing loaded in production without its variables: the worker refuses to start, before any query", async () => {
    const queries: string[] = [];
    await expect(loadWorkerPro({ OHB_PRO_PLUGINS: "billing" }, roleDb(queries), { billingEnforced: true, environment: "production" }, silent, {
      importer: importerFor({ billing: payingBilling() }),
    })).rejects.toThrow(MESSAGE);
    expect(queries).toEqual([]);
    expect(() => assertWorkerProPluginProductionEnv([payingBilling()], { PAY_SECRET: "s", PAY_PRICE: "  " })).toThrow("billing: PAY_PRICE.");
  });

  test("with every variable, or outside production, billing loads", async () => {
    const full = await loadWorkerPro({ OHB_PRO_PLUGINS: "billing", PAY_SECRET: "s", PAY_PRICE: "p" }, roleDb([]), { billingEnforced: true, environment: "production" }, silent, {
      importer: importerFor({ billing: payingBilling() }),
    });
    expect(full.plugins.map((loaded) => loaded.manifest.id)).toEqual(["billing"]);
    for (const environment of ["development", "test", undefined]) {
      const dev = await loadWorkerPro({ OHB_PRO_PLUGINS: "billing" }, roleDb([]), { billingEnforced: true, environment }, silent, {
        importer: importerFor({ billing: payingBilling() }),
      });
      expect(dev.plugins.map((loaded) => loaded.manifest.id)).toEqual(["billing"]);
    }
  });

  test("the worker passes its configuration, environment included, to the loader", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source).toContain("const pro = await loadWorkerPro(process.env, db, baseConfig, {");
    expect(source.indexOf("const baseConfig = readWorkerConfig();")).toBeLessThan(source.indexOf("const pro = await loadWorkerPro("));
  });
});

describe("one owner per deployment variable (step 11.5)", () => {
  test("two loaded plug-ins declaring the same variable stop the worker, in every environment, before any query", async () => {
    const owning = (id: string) => {
      const base = plugin(id);
      return { ...base, manifest: { ...base.manifest, env: [{ name: "PAY_KEY" }] } } as ProPlugin;
    };
    for (const environment of ["development", "production"]) {
      const queries: string[] = [];
      await expect(loadWorkerPro({ OHB_PRO_PLUGINS: "billing,payments", PAY_KEY: "k" }, roleDb(queries), { billingEnforced: false, environment }, silent, {
        importer: importerFor({ billing: owning("billing"), payments: owning("payments") }),
      })).rejects.toThrow("Deployment variable declared by more than one loaded plug-in: PAY_KEY (billing, payments).");
      expect(queries).toEqual([]);
    }
  });
});
