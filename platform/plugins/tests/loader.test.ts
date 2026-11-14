import { describe, expect, test } from "bun:test";
import {
  approvalReviewerOf,
  assertDistinctPluginEnv,
  auditArchiveOf,
  compatPathAliasesOf,
  declaredEntitlements,
  invalidPluginReason,
  hookContext,
  loadProPlugins,
  missingProductionEnv,
  parsePluginList,
  pluginDeployEnv,
  sharedPluginEnv,
  PLUGIN_API_VERSION,
  PLUGIN_ENV_MAX,
  type ProPlugin,
} from "../src";

/** A neutral payment webhook path a fixture billing plug-in declares (step 11.5). */
const PAY_PATH = "/api/pay/webhook";

const plugin = (id: string, extra: Partial<ProPlugin> = {}): ProPlugin => ({
  manifest: { id, version: "0.1.0", pluginApi: PLUGIN_API_VERSION, entitlements: [`${id}.feature`] },
  ...extra,
});

const importerFor = (modules: Record<string, unknown>) => async (specifier: string) => {
  if (!(specifier in modules)) throw new Error(`Cannot find module '${specifier}'`);
  return modules[specifier];
};

describe("parsePluginList", () => {
  test("empty means no plug-in", () => {
    expect(parsePluginList(undefined)).toEqual([]);
    expect(parsePluginList("  ")).toEqual([]);
  });

  test("trims, drops blanks and duplicates, keeps order", () => {
    expect(parsePluginList(" @acme/plugin-reports, ,@acme/plugin-export,@acme/plugin-reports")).toEqual([
      "@acme/plugin-reports",
      "@acme/plugin-export",
    ]);
  });
});

describe("loadProPlugins", () => {
  test("no specifier loads nothing and needs no package", async () => {
    const result = await loadProPlugins([], { importer: async () => { throw new Error("must not import"); } });
    expect(result).toEqual({ plugins: [], skipped: [] });
  });

  test("loads a default export and a namespace export", async () => {
    const a = plugin("reports");
    const b = plugin("audit");
    const result = await loadProPlugins(["a", "b"], { importer: importerFor({ a: { default: a }, b }) });
    expect(result.plugins.map((p) => p.manifest.id)).toEqual(["reports", "audit"]);
    expect(result.skipped).toEqual([]);
  });

  test("a missing package is skipped and reported, never thrown", async () => {
    const warnings: string[] = [];
    const result = await loadProPlugins(["@openedbot/pro-missing"], {
      importer: importerFor({}),
      warn: (skip) => warnings.push(skip.specifier),
    });
    expect(result.plugins).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("cannot import");
    expect(warnings).toEqual(["@openedbot/pro-missing"]);
  });

  test("an incompatible plug-in API version is skipped", async () => {
    const old = { manifest: { ...plugin("reports").manifest, pluginApi: 0 } };
    const result = await loadProPlugins(["a"], { importer: importerFor({ a: old }) });
    expect(result.skipped[0]?.reason).toContain("plug-in API 0");
  });

  test("a duplicate id keeps the first plug-in", async () => {
    const result = await loadProPlugins(["a", "b"], {
      importer: importerFor({ a: plugin("reports"), b: plugin("reports") }),
    });
    expect(result.plugins).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("duplicate");
  });

  test("the license gate can refuse or fail without stopping the others", async () => {
    const result = await loadProPlugins(["a", "b", "c"], {
      importer: importerFor({ a: plugin("reports"), b: plugin("audit"), c: plugin("billing") }),
      allow: (p) => {
        if (p.manifest.id === "audit") throw new Error("license server down");
        return p.manifest.id !== "billing";
      },
    });
    expect(result.plugins.map((p) => p.manifest.id)).toEqual(["reports"]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "license check failed: license server down",
      "not allowed by the license",
    ]);
  });

  test("declaredEntitlements unions the manifests", async () => {
    expect([...declaredEntitlements([plugin("reports"), plugin("audit")])]).toEqual(["reports.feature", "audit.feature"]);
  });
});

describe("invalidPluginReason", () => {
  test("accepts a complete plug-in", () => {
    expect(
      invalidPluginReason(
        plugin("reports", {
          api: [
            { prefix: "/clients", access: "session", entitlement: "reports.feature", build: () => null },
            { prefix: "/invite", access: "public", build: () => null },
          ],
          migrations: { directory: "/opt/pro/reports/migrations" },
          console: { module: "@acme/plugin-reports/console" },
        }),
      ),
    ).toBeNull();
  });

  test.each([
    [null, "does not export"],
    [{}, "missing manifest"],
    [{ manifest: { id: "Reports", version: "1", pluginApi: 1, entitlements: [] } }, "manifest.id"],
    [{ manifest: { id: "reports", version: "", pluginApi: 1, entitlements: [] } }, "manifest.version"],
    [{ manifest: { id: "reports", version: "1", pluginApi: 1, entitlements: ["audit.x"] } }, "invalid entitlement"],
  ])("refuses %p", (value, reason) => {
    expect(invalidPluginReason(value)).toContain(reason);
  });

  test("a session mount must be gated by a declared entitlement", () => {
    const build = () => null;
    expect(invalidPluginReason(plugin("reports", { api: [{ prefix: "/x", access: "session", build }] }))).toContain("must name");
    expect(
      invalidPluginReason(plugin("reports", { api: [{ prefix: "/x", access: "session", entitlement: "reports.other", build }] })),
    ).toContain("undeclared");
  });

  test("refuses a mount prefix that could escape its root", () => {
    const build = () => null;
    expect(invalidPluginReason(plugin("reports", { api: [{ prefix: "/../auth", access: "public", build }] }))).toContain("prefix");
    expect(invalidPluginReason(plugin("reports", { api: [{ prefix: "auth", access: "public", build }] }))).toContain("prefix");
  });
});

describe("invalidPluginReason: worker jobs", () => {
  const run = async () => undefined;
  test("accepts named jobs of at least a minute, with or without enabled()", () => {
    expect(invalidPluginReason(plugin("audit", { jobs: [
      { name: "purge-expired", everyMs: 3_600_000, enabled: () => false, run },
      { name: "reconcile", everyMs: 60_000, run },
    ] }))).toBeNull();
  });

  test.each([
    [{ jobs: "nope" }, "invalid jobs"],
    [{ jobs: [{ name: "Purge", everyMs: 60_000, run }] }, "invalid job name"],
    [{ jobs: [{ name: "purge", everyMs: 1_000, run }] }, "at least 60000"],
    [{ jobs: [{ name: "purge", everyMs: 60_000.5, run }] }, "everyMs"],
    [{ jobs: [{ name: "purge", everyMs: 60_000 }] }, "without run()"],
    [{ jobs: [{ name: "purge", everyMs: 60_000, run, enabled: true }] }, "invalid enabled"],
    [{ jobs: [{ name: "purge", everyMs: 60_000, run }, { name: "purge", everyMs: 60_000, run }] }, "duplicate job"],
  ])("refuses %p", (extra, reason) => {
    expect(invalidPluginReason(plugin("audit", extra as Partial<ProPlugin>))).toContain(reason);
  });
});

describe("invalidPluginReason: permissionRules", () => {
  const read = async () => ({ organizationPolicy: { ceiling: null, enforceReview: false, commandBlocklist: [] }, toolPolicy: null, grants: { grantId: null, terminalAlways: false } });
  const permissions = (extra: Partial<ProPlugin>, entitlements = ["permissions.v2"]) => {
    const base = plugin("permissions", extra);
    return { ...base, manifest: { ...base.manifest, entitlements } };
  };

  test("accepts a read() on the plug-in permissions declaring permissions.v2", () => {
    expect(invalidPluginReason(permissions({ permissionRules: { read } }))).toBeNull();
  });

  test.each([[{ permissionRules: "nope" }], [{ permissionRules: {} }], [{ permissionRules: { read: true } }]])("refuses %p", (extra) => {
    expect(invalidPluginReason(permissions(extra as unknown as Partial<ProPlugin>))).toBe("invalid permissionRules");
  });

  test("accepts \"Never wait\" next to read() (step 8b)", () => {
    const unattended = async () => false;
    expect(invalidPluginReason(permissions({ permissionRules: { read, unattended } }))).toBeNull();
  });

  test.each([["unattended"]])("refuses a %s that is not a function", (member) => {
    expect(invalidPluginReason(permissions({ permissionRules: { read, [member]: "nope" } } as unknown as Partial<ProPlugin>)))
      .toBe(`invalid permissionRules.${member}`);
  });

  test("refuses the source from another plug-in, or without the entitlement", () => {
    expect(invalidPluginReason(plugin("staff", { permissionRules: { read } }))).toContain("permissionRules needs");
    expect(invalidPluginReason(permissions({ permissionRules: { read } }, []))).toContain("permissionRules needs");
  });
});

describe("approvalReviewer: the automatic reviewer (open-core boundary)", () => {
  const ready = async () => true;
  const pass = { name: "approval-reviews", everyMs: 500, run: async () => undefined };
  const reviewer = { ready, passes: [pass] };

  test("accepted from the plug-in permissions only, and read back by approvalReviewerOf", () => {
    expect(invalidPluginReason(plugin("permissions", { approvalReviewer: reviewer }))).toBeNull();
    expect(invalidPluginReason(plugin("permissions", { approvalReviewer: { ready, passes: [] } }))).toBeNull();
    expect(invalidPluginReason(plugin("audit", { approvalReviewer: reviewer }))).toBe('approvalReviewer needs the plug-in "permissions"');
    expect(approvalReviewerOf([plugin("audit"), plugin("permissions", { approvalReviewer: reviewer })])).toBe(reviewer);
  });

  test("solo, or a permissions plug-in without reviewer: the core's default (null)", () => {
    expect(approvalReviewerOf([])).toBeNull();
    expect(approvalReviewerOf([plugin("permissions")])).toBeNull();
  });

  test.each([
    [{ approvalReviewer: "nope" }, "invalid approvalReviewer"],
    [{ approvalReviewer: { passes: [] } }, "invalid approvalReviewer"],
    [{ approvalReviewer: { ready } }, "invalid approvalReviewer"],
    [{ approvalReviewer: { ready, passes: [{ ...pass, name: "Bad Name" }] } }, "invalid approvalReviewer pass name"],
    [{ approvalReviewer: { ready, passes: [pass, pass] } }, 'duplicate approvalReviewer pass "approval-reviews"'],
    // Jobs and passes share the worker's scheduler keys (`pro:permissions:<name>`).
    [{ jobs: [{ name: "approval-reviews", everyMs: 60_000, run: async () => undefined }], approvalReviewer: { ready, passes: [pass] } },
      'approvalReviewer pass "approval-reviews" has the name of a job'],
    [{ approvalReviewer: { ready, passes: [{ ...pass, everyMs: 100 }] } }, 'approvalReviewer pass "approval-reviews": everyMs must be an integer of at least 250'],
    [{ approvalReviewer: { ready, passes: [{ ...pass, run: undefined }] } }, 'approvalReviewer pass "approval-reviews" without run()'],
  ])("refuses %p", (extra, reason) => {
    expect(invalidPluginReason(plugin("permissions", extra as unknown as Partial<ProPlugin>))).toBe(reason);
  });
});

describe("auditArchive: the external audit archive (open-core boundary)", () => {
  const archive = { id: "worm:r2", put: async () => undefined, get: async () => null };

  test("accepted from the plug-in audit only, and read back by auditArchiveOf", () => {
    expect(invalidPluginReason(plugin("audit", { auditArchive: archive }))).toBeNull();
    expect(invalidPluginReason(plugin("audit", { auditArchive: { ...archive, orphaned: async () => undefined } }))).toBeNull();
    expect(invalidPluginReason(plugin("staff", { auditArchive: archive }))).toBe('auditArchive needs the plug-in "audit"');
    expect(auditArchiveOf([plugin("billing"), plugin("audit", { auditArchive: archive })])).toBe(archive);
  });

  test("solo, or an audit plug-in without archive: the core's default (null)", () => {
    expect(auditArchiveOf([])).toBeNull();
    expect(auditArchiveOf([plugin("audit")])).toBeNull();
  });

  test.each([
    [{ auditArchive: "nope" }, "invalid auditArchive"],
    [{ auditArchive: { id: "x", get: archive.get } }, "invalid auditArchive"],
    [{ auditArchive: { id: "x", put: archive.put } }, "invalid auditArchive"],
    [{ auditArchive: { ...archive, id: "" } }, "invalid auditArchive.id"],
    [{ auditArchive: { ...archive, id: "x".repeat(129) } }, "invalid auditArchive.id"],
    [{ auditArchive: { ...archive, orphaned: true } }, "invalid auditArchive.orphaned"],
  ])("refuses %p", (extra, reason) => {
    expect(invalidPluginReason(plugin("audit", extra as unknown as Partial<ProPlugin>))).toBe(reason);
  });
});

describe("billing hooks (step 8c)", () => {
  const webhook = async () => new Response(null, { status: 204 });

  test("accepts the payment webhook from the plug-in billing only", () => {
    expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook } }))).toBeNull();
    expect(invalidPluginReason(plugin("staff", { billing: { webhookPath: PAY_PATH, webhook } }))).toBe('billing needs the plug-in "billing"');
  });

  test("refuses billing hooks without a webhook function", () => {
    expect(invalidPluginReason(plugin("billing", { billing: {} } as unknown as Partial<ProPlugin>))).toBe("invalid billing");
    expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook: "nope" } } as unknown as Partial<ProPlugin>))).toBe("invalid billing");
  });
});

describe("onOrganizationCreating (step 8d)", () => {
  const onOrganizationCreating = async () => undefined;

  test("accepted from the plug-in billing only", () => {
    expect(invalidPluginReason(plugin("billing", { hooks: { onOrganizationCreating } }))).toBeNull();
    expect(invalidPluginReason(plugin("reports", { hooks: { onOrganizationCreating } }))).toBe('onOrganizationCreating needs the plug-in "billing"');
    expect(invalidPluginReason(plugin("audit", { hooks: { onTenantDeleting: async () => undefined } }))).toBeNull();
  });

  test("refuses a hook that is not a function, and hooks that are not an object", () => {
    expect(invalidPluginReason(plugin("billing", { hooks: { onOrganizationCreating: "nope" } } as unknown as Partial<ProPlugin>))).toBe("invalid hooks.onOrganizationCreating");
    expect(invalidPluginReason(plugin("billing", { hooks: "nope" } as unknown as Partial<ProPlugin>))).toBe("invalid hooks");
  });
});

describe("billing.subscriptions (step 8d)", () => {
  const webhook = async () => new Response(null);
  const port = { status: async () => null, read: async () => null, readForUpdate: async () => null, admission: () => null };

  test("a whole port is accepted from the plug-in billing, and the webhook alone still is", () => {
    expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: port } }))).toBeNull();
    expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook } }))).toBeNull();
    expect(invalidPluginReason(plugin("reports", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: port } }))).toBe('billing needs the plug-in "billing"');
  });

  test("a port missing a member, or with one that is not a function, is refused", () => {
    for (const member of ["status", "read", "readForUpdate", "admission"] as const) {
      const { [member]: _dropped, ...partial } = port;
      expect([member, invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: partial } } as unknown as Partial<ProPlugin>))]).toEqual([member, "invalid billing.subscriptions"]);
      expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: { ...port, [member]: 1 } } } as unknown as Partial<ProPlugin>))).toBe("invalid billing.subscriptions");
    }
    expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: "nope" } } as unknown as Partial<ProPlugin>))).toBe("invalid billing.subscriptions");
  });
});

describe("path aliases", () => {
  const acme = (aliases: unknown): ProPlugin => ({
    manifest: { id: "acme", version: "0.1.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
    aliases: aliases as ProPlugin["aliases"],
  });

  test("a well-formed path alias is accepted and listed", () => {
    const aliases = { paths: [{ from: "/api/acme", to: "/api/pro/acme" }] };
    expect(invalidPluginReason(acme(aliases))).toBeNull();
    expect(compatPathAliasesOf([acme(aliases), plugin("other")])).toEqual(aliases.paths);
  });

  test("a capability-style entitlement of another id is refused", () => {
    expect(invalidPluginReason(plugin("acme", { manifest: { ...plugin("acme").manifest, entitlements: ["shared.workspaces"] } })))
      .toContain("invalid entitlement");
  });

  test.each([
    [{ colours: [] }, "invalid aliases.colours"],
    [{ headers: [{ from: "X-OpenedBot-Acme", to: "X-OpenedBot-Organization" }] }, "invalid aliases.headers"],
    [{ paths: [{ from: "/api/acme/x", to: "/api/pro/acme" }, { from: "/api", to: "/api/pro/acme" }] }, "too broad"],
    // No alias touches the session root, exact or not, in either direction.
    [{ paths: [{ from: "/api/auth/x", to: "/api/pro/acme" }] }, "touches /api/auth"],
    [{ paths: [{ from: "/api/auth/x", to: "/api/pro/acme", exact: true }] }, "touches /api/auth"],
    [{ paths: [{ from: "/api/acme/old", to: "/api/auth/me", exact: true }] }, "touches /api/auth"],
    [{ paths: [{ from: "/api/acme/old", to: "/api/pro/acme", exact: "yes" }] }, "invalid aliases.paths entry"],
    [{ paths: [{ from: "/api/pro/acme", to: "/api/acme" }] }, "reserved"],
    [{ paths: [{ from: "/internal/acme", to: "/api/acme" }] }, "reserved"],
    [{ paths: [{ from: "/api/acme", to: "/api/acme/v2" }] }, "loops"],
    [{ paths: [{ from: "/api/Acme/", to: "/api/pro/acme" }] }, "invalid path alias"],
  ])("refuses %j", (aliases, reason) => {
    expect(invalidPluginReason(acme(aliases))).toContain(reason);
  });
});

describe("manifest.env: deployment variables a plug-in declares (step 11.5)", () => {
  const declaring = (env: unknown) => plugin("billing", { manifest: { ...plugin("billing").manifest, env } as ProPlugin["manifest"] });

  test("accepts plain upper-case names, optional or required in production", () => {
    expect(invalidPluginReason(declaring([]))).toBeNull();
    expect(invalidPluginReason(declaring([{ name: "PAY_SECRET_KEY", requiredInProduction: true }, { name: "PAY_REGION" }, { name: "PAY_V2_MODE", requiredInProduction: false }]))).toBeNull();
  });

  test("refuses a malformed list or entry", () => {
    expect(invalidPluginReason(declaring("PAY_KEY"))).toBe("invalid manifest.env");
    expect(invalidPluginReason(declaring(Array.from({ length: PLUGIN_ENV_MAX + 1 }, (_, index) => ({ name: `PAY_KEY_${index}` }))))).toBe("invalid manifest.env");
    for (const entry of [null, "PAY_KEY", { name: "pay_key" }, { name: "PAYKEY" }, { name: "PAY__KEY" }, { name: "PAY_KEY_" }, { name: "1PAY_KEY" }, { name: "PAY-KEY" }, { name: "PAY_KEY", requiredInProduction: "yes" }]) {
      expect([entry, invalidPluginReason(declaring([entry]))]).toEqual([entry, "invalid manifest.env entry"]);
    }
  });

  test("refuses an OPENEDBOT_* name, a reserved core name and a duplicate", () => {
    expect(invalidPluginReason(declaring([{ name: "OPENEDBOT_PLUGINS" }]))).toBe('manifest.env "OPENEDBOT_PLUGINS" is a core variable');
    expect(invalidPluginReason(declaring([{ name: "OPENEDBOT_BILLING_KEY" }]))).toBe('manifest.env "OPENEDBOT_BILLING_KEY" is a core variable');
    const reservedEnv = (name: string) => name === "API_DATABASE_URL";
    expect(invalidPluginReason(declaring([{ name: "API_DATABASE_URL" }]), { reservedEnv })).toBe('manifest.env "API_DATABASE_URL" is a core variable');
    expect(invalidPluginReason(declaring([{ name: "API_DATABASE_URL" }]))).toBeNull();
    expect(invalidPluginReason(declaring([{ name: "PAY_KEY" }, { name: "PAY_KEY" }]))).toBe('duplicate manifest.env "PAY_KEY"');
  });

  test("the loader passes reservedEnv through and skips the plug-in", async () => {
    const result = await loadProPlugins(["@acme/billing"], {
      importer: importerFor({ "@acme/billing": { default: declaring([{ name: "API_DATABASE_URL" }]) } }),
      reservedEnv: (name) => name === "API_DATABASE_URL",
    });
    expect(result.plugins).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('manifest.env "API_DATABASE_URL" is a core variable');
  });

  test("pluginDeployEnv: only the declared, non-empty values, frozen; nothing declared is undefined", () => {
    const env = { PAY_KEY: "k", PAY_EMPTY: " ", OTHER: "o", API_DATABASE_URL: "postgres://x" };
    expect(pluginDeployEnv(undefined, env)).toBeUndefined();
    expect(pluginDeployEnv([], env)).toBeUndefined();
    const values = pluginDeployEnv([{ name: "PAY_KEY" }, { name: "PAY_EMPTY" }, { name: "PAY_UNSET" }], env);
    expect(values).toEqual({ PAY_KEY: "k" });
    expect(Object.isFrozen(values)).toBe(true);
  });

  test("hookContext: env only for a plug-in that declares some", () => {
    const env = { PAY_KEY: "k", OPENEDBOT_PLUGIN_BILLING__X: "y", OTHER: "o" };
    expect(hookContext(plugin("billing"), env)).toEqual({ config: { X: "y" } });
    expect(hookContext("billing", env)).toEqual({ config: { X: "y" } });
    expect(hookContext(declaring([{ name: "PAY_KEY" }]), env)).toEqual({ config: { X: "y" }, env: { PAY_KEY: "k" } });
  });

  test("missingProductionEnv: required, unset or blank, per loaded plug-in", () => {
    const plugins = [declaring([{ name: "PAY_KEY", requiredInProduction: true }, { name: "PAY_REGION" }]), plugin("staff")];
    expect(missingProductionEnv(plugins, {})).toEqual(["billing: PAY_KEY"]);
    expect(missingProductionEnv(plugins, { PAY_KEY: "  " })).toEqual(["billing: PAY_KEY"]);
    expect(missingProductionEnv(plugins, { PAY_KEY: "k" })).toEqual([]);
    expect(missingProductionEnv([], {})).toEqual([]);
  });

  test("a deployment variable declared by two loaded plug-ins is refused, naming it and both owners (step 11.5)", () => {
    const owning = (id: string, env: { name: string; requiredInProduction?: boolean }[]) =>
      plugin(id, { manifest: { ...plugin(id).manifest, env } as ProPlugin["manifest"] });
    const billing = owning("billing", [{ name: "PAY_KEY", requiredInProduction: true }, { name: "PAY_REGION" }]);
    const staff = owning("staff", [{ name: "STAFF_KEY" }]);
    expect(sharedPluginEnv([])).toEqual([]);
    expect(sharedPluginEnv([billing, staff, plugin("reports")])).toEqual([]);
    expect(() => assertDistinctPluginEnv([])).not.toThrow();
    expect(() => assertDistinctPluginEnv([billing, staff])).not.toThrow();
    // Optional or required, the name is what matters.
    const rival = owning("payments", [{ name: "PAY_KEY" }, { name: "STAFF_KEY", requiredInProduction: true }]);
    expect(sharedPluginEnv([billing, staff, rival])).toEqual(["PAY_KEY (billing, payments)", "STAFF_KEY (staff, payments)"]);
    expect(() => assertDistinctPluginEnv([billing, rival])).toThrow(
      "Deployment variable declared by more than one loaded plug-in: PAY_KEY (billing, payments).",
    );
  });
});

describe("billing.webhookPath: the plug-in names its webhook path (step 11.5)", () => {
  const webhook = async () => new Response(null, { status: 204 });
  const withPath = (webhookPath: unknown) => plugin("billing", { billing: { webhookPath, webhook } } as unknown as Partial<ProPlugin>);

  test("accepts a static path under /api with two more segments", () => {
    for (const path of ["/api/pay/webhook", "/api/provider/v2/events", "/api/a_b/c-d"]) expect([path, invalidPluginReason(withPath(path))]).toEqual([path, null]);
  });

  test("refuses a missing, malformed, parameterised or too broad path", () => {
    for (const path of [undefined, 42, "", "api/pay/webhook", "/api/pay", "/api", "/pay/webhook", "/internal/pay/webhook", "/api/pay/:id", "/api/pay/*", "/api/Pay/webhook", "/api/pay/webhook/", "/api//webhook", "/api/pay/webhook?x=1"]) {
      expect([path, invalidPluginReason(withPath(path))]).toEqual([path, "invalid billing.webhookPath"]);
    }
  });

  test("refuses the plug-in mounts, the session routes and the hook ingress", () => {
    for (const path of ["/api/pro/billing", "/api/pro/billing/webhook", "/api/auth/webhook", "/api/hooks/pay"]) {
      expect([path, invalidPluginReason(withPath(path))]).toEqual([path, `billing.webhookPath ${JSON.stringify(path)} is reserved`]);
    }
  });
});
