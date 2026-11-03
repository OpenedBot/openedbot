import { describe, expect, test } from "bun:test";
import {
  SESSION_ALIAS_TARGETS,
  assertDistinctPluginEnv,
  capabilitiesOf,
  compatAliasesOf,
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
    const a = plugin("agency");
    const b = plugin("audit");
    const result = await loadProPlugins(["a", "b"], { importer: importerFor({ a: { default: a }, b }) });
    expect(result.plugins.map((p) => p.manifest.id)).toEqual(["agency", "audit"]);
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
    const old = { manifest: { ...plugin("agency").manifest, pluginApi: 0 } };
    const result = await loadProPlugins(["a"], { importer: importerFor({ a: old }) });
    expect(result.skipped[0]?.reason).toContain("plug-in API 0");
  });

  test("a duplicate id keeps the first plug-in", async () => {
    const result = await loadProPlugins(["a", "b"], {
      importer: importerFor({ a: plugin("agency"), b: plugin("agency") }),
    });
    expect(result.plugins).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("duplicate");
  });

  test("the license gate can refuse or fail without stopping the others", async () => {
    const result = await loadProPlugins(["a", "b", "c"], {
      importer: importerFor({ a: plugin("agency"), b: plugin("audit"), c: plugin("billing") }),
      allow: (p) => {
        if (p.manifest.id === "audit") throw new Error("license server down");
        return p.manifest.id !== "billing";
      },
    });
    expect(result.plugins.map((p) => p.manifest.id)).toEqual(["agency"]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "license check failed: license server down",
      "not allowed by the license",
    ]);
  });

  test("declaredEntitlements unions the manifests", async () => {
    expect([...declaredEntitlements([plugin("agency"), plugin("audit")])]).toEqual(["agency.feature", "audit.feature"]);
  });
});

describe("invalidPluginReason", () => {
  test("accepts a complete plug-in", () => {
    expect(
      invalidPluginReason(
        plugin("agency", {
          api: [
            { prefix: "/clients", access: "session", entitlement: "agency.feature", build: () => null },
            { prefix: "/invite", access: "public", build: () => null },
          ],
          migrations: { directory: "/opt/pro/agency/migrations" },
          console: { module: "@acme/plugin-reports/console" },
        }),
      ),
    ).toBeNull();
  });

  test.each([
    [null, "does not export"],
    [{}, "missing manifest"],
    [{ manifest: { id: "Agency", version: "1", pluginApi: 1, entitlements: [] } }, "manifest.id"],
    [{ manifest: { id: "agency", version: "", pluginApi: 1, entitlements: [] } }, "manifest.version"],
    [{ manifest: { id: "agency", version: "1", pluginApi: 1, entitlements: ["audit.x"] } }, "invalid entitlement"],
  ])("refuses %p", (value, reason) => {
    expect(invalidPluginReason(value)).toContain(reason);
  });

  test("a session mount must be gated by a declared entitlement", () => {
    const build = () => null;
    expect(invalidPluginReason(plugin("agency", { api: [{ prefix: "/x", access: "session", build }] }))).toContain("must name");
    expect(
      invalidPluginReason(plugin("agency", { api: [{ prefix: "/x", access: "session", entitlement: "agency.other", build }] })),
    ).toContain("undeclared");
  });

  test("refuses a mount prefix that could escape its root", () => {
    const build = () => null;
    expect(invalidPluginReason(plugin("agency", { api: [{ prefix: "/../auth", access: "public", build }] }))).toContain("prefix");
    expect(invalidPluginReason(plugin("agency", { api: [{ prefix: "auth", access: "public", build }] }))).toContain("prefix");
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

describe("invalidPluginReason: impersonation", () => {
  test("accepts a source with claim()", () => {
    expect(invalidPluginReason(plugin("staff", { impersonation: { claim: async () => null } }))).toBeNull();
  });

  test.each([
    [{ impersonation: "nope" }],
    [{ impersonation: {} }],
    [{ impersonation: { claim: true } }],
  ])("refuses %p", (extra) => {
    expect(invalidPluginReason(plugin("staff", extra as unknown as Partial<ProPlugin>))).toBe("invalid impersonation");
  });
});

describe("invalidPluginReason: supportDesk", () => {
  test("accepts a provider with build()", () => {
    expect(invalidPluginReason(plugin("staff", { supportDesk: { build: () => ({ fetch: () => new Response() }) } }))).toBeNull();
  });

  test.each([
    [{ supportDesk: "nope" }],
    [{ supportDesk: {} }],
    [{ supportDesk: { build: true } }],
  ])("refuses %p", (extra) => {
    expect(invalidPluginReason(plugin("staff", extra as unknown as Partial<ProPlugin>))).toBe("invalid supportDesk");
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

  test("accepts the reviewer's rules and \"Never wait\" next to read() (step 8b)", () => {
    const reviewRules = async () => ({ rulesMode: null, rules: [] });
    const unattended = async () => false;
    expect(invalidPluginReason(permissions({ permissionRules: { read, reviewRules, unattended } }))).toBeNull();
  });

  test.each([["reviewRules"], ["unattended"]])("refuses a %s that is not a function", (member) => {
    expect(invalidPluginReason(permissions({ permissionRules: { read, [member]: "nope" } } as unknown as Partial<ProPlugin>)))
      .toBe(`invalid permissionRules.${member}`);
  });

  test("refuses the source from another plug-in, or without the entitlement", () => {
    expect(invalidPluginReason(plugin("staff", { permissionRules: { read } }))).toContain("permissionRules needs");
    expect(invalidPluginReason(permissions({ permissionRules: { read } }, []))).toContain("permissionRules needs");
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
    expect(invalidPluginReason(plugin("agency", { hooks: { onOrganizationCreating } }))).toBe('onOrganizationCreating needs the plug-in "billing"');
    expect(invalidPluginReason(plugin("audit", { hooks: { onTenantDeleting: async () => undefined } }))).toBeNull();
  });

  test("refuses a hook that is not a function, and hooks that are not an object", () => {
    expect(invalidPluginReason(plugin("billing", { hooks: { onOrganizationCreating: "nope" } } as unknown as Partial<ProPlugin>))).toBe("invalid hooks.onOrganizationCreating");
    expect(invalidPluginReason(plugin("billing", { hooks: "nope" } as unknown as Partial<ProPlugin>))).toBe("invalid hooks");
  });
});

describe("billing.subscriptions (step 8d)", () => {
  const webhook = async () => new Response(null);
  const port = { memberLimit: async () => null, status: async () => null, read: async () => null, readForUpdate: async () => null, admission: () => null };

  test("a whole port is accepted from the plug-in billing, and the webhook alone still is", () => {
    expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: port } }))).toBeNull();
    expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook } }))).toBeNull();
    expect(invalidPluginReason(plugin("agency", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: port } }))).toBe('billing needs the plug-in "billing"');
  });

  test("a port missing a member, or with one that is not a function, is refused", () => {
    for (const member of ["memberLimit", "status", "read", "readForUpdate", "admission"] as const) {
      const { [member]: _dropped, ...partial } = port;
      expect([member, invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: partial } } as unknown as Partial<ProPlugin>))]).toEqual([member, "invalid billing.subscriptions"]);
      expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: { ...port, [member]: 1 } } } as unknown as Partial<ProPlugin>))).toBe("invalid billing.subscriptions");
    }
    expect(invalidPluginReason(plugin("billing", { billing: { webhookPath: PAY_PATH, webhook, subscriptions: "nope" } } as unknown as Partial<ProPlugin>))).toBe("invalid billing.subscriptions");
  });
});

describe("capabilities and compatibility aliases (step 11.2)", () => {
  const fleet = (id: string, extra: Partial<ProPlugin> = {}): ProPlugin => ({
    manifest: { id, version: "0.1.0", pluginApi: PLUGIN_API_VERSION, entitlements: ["fleet.workspaces", `${id}.workspaces`] },
    ...extra,
  });

  test("a capability entitlement may be declared by any id, and has one provider", async () => {
    expect(invalidPluginReason(fleet("acme"))).toBeNull();
    expect(capabilitiesOf(fleet("acme"))).toEqual(["fleet"]);
    expect(capabilitiesOf(plugin("acme"))).toEqual([]);
    const { plugins, skipped } = await loadProPlugins(["@x/first", "@x/second"], { importer: importerFor({ "@x/first": { default: fleet("first") }, "@x/second": { default: fleet("second") } }) });
    expect(plugins.map((entry) => entry.manifest.id)).toEqual(["first"]);
    expect(skipped).toEqual([{ specifier: "@x/second", reason: "capability fleet.workspaces already provided" }]);
  });

  test("well-formed aliases are accepted and listed by kind", () => {
    const aliases = {
      headers: [{ from: "X-OpenedBot-Acme", to: "X-OpenedBot-Fleet" }],
      queries: [{ from: "acmeId", to: "fleetId" }],
      paths: [{ from: "/api/acme", to: "/api/pro/acme" }],
      entitlements: [{ from: "acme.workspaces", to: "fleet.workspaces" }],
    };
    expect(invalidPluginReason(fleet("acme", { aliases }))).toBeNull();
    expect(compatAliasesOf([fleet("acme", { aliases }), plugin("other")])).toEqual(aliases);
  });

  test("an old session path may point, exactly, at an allowlisted session target", () => {
    expect(SESSION_ALIAS_TARGETS).toEqual(["/api/auth/assisted-sessions/claim"]);
    const aliases = { paths: [{ from: "/api/auth/old-claim", to: "/api/auth/assisted-sessions/claim", exact: true }] };
    expect(invalidPluginReason(fleet("acme", { aliases }))).toBeNull();
  });

  test.each([
    [{ colours: [] }, "invalid aliases.colours"],
    [{ headers: [{ from: "Authorization", to: "X-OpenedBot-Fleet" }] }, "invalid header alias"],
    [{ queries: [{ from: "a-b", to: "fleetId" }] }, "invalid query alias"],
    [{ headers: [{ from: "X-OpenedBot-Fleet", to: "X-OpenedBot-Fleet" }] }, "invalid aliases.headers entry"],
    [{ paths: [{ from: "/api/acme/x", to: "/api/pro/acme" }, { from: "/api", to: "/api/pro/acme" }] }, "too broad"],
    // The session root: exact only, towards the core allowlist only, never a subtree.
    [{ paths: [{ from: "/api/auth/x", to: "/api/pro/acme" }] }, "must be exact and target an allowlisted path"],
    [{ paths: [{ from: "/api/auth/x", to: "/api/pro/acme", exact: true }] }, "must be exact and target an allowlisted path"],
    [{ paths: [{ from: "/api/auth/old-claim", to: "/api/auth/assisted-sessions/claim" }] }, "must be exact and target an allowlisted path"],
    [{ paths: [{ from: "/api/auth", to: "/api/auth/assisted-sessions/claim", exact: true }] }, "loops"],
    [{ paths: [{ from: "/api/acme/old", to: "/api/auth/me", exact: true }] }, "must be exact and target an allowlisted path"],
    [{ paths: [{ from: "/api/acme/old", to: "/api/pro/acme", exact: "yes" }] }, "invalid aliases.paths entry"],
    [{ headers: [{ from: "X-OpenedBot-Acme", to: "X-OpenedBot-Fleet", exact: true }] }, "invalid aliases.headers entry"],
    [{ paths: [{ from: "/api/pro/acme", to: "/api/acme" }] }, "reserved"],
    [{ paths: [{ from: "/internal/acme", to: "/api/acme" }] }, "reserved"],
    [{ paths: [{ from: "/api/acme", to: "/api/acme/v2" }] }, "loops"],
    [{ paths: [{ from: "/api/Acme/", to: "/api/pro/acme" }] }, "invalid path alias"],
    [{ entitlements: [{ from: "other.workspaces", to: "fleet.workspaces" }] }, "must be declared under the plug-in id"],
    [{ entitlements: [{ from: "acme.workspaces", to: "fleet.billing" }] }, "is not declared"],
  ])("refuses %j", (aliases, reason) => {
    expect(invalidPluginReason(fleet("acme", { aliases } as unknown as Partial<ProPlugin>))).toContain(reason);
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

  test("refuses an OPENEDBOT_* or retired OHB_* name, a reserved core name and a duplicate", () => {
    expect(invalidPluginReason(declaring([{ name: "OPENEDBOT_PLUGINS" }]))).toBe('manifest.env "OPENEDBOT_PLUGINS" is a core variable');
    expect(invalidPluginReason(declaring([{ name: "OPENEDBOT_BILLING_KEY" }]))).toBe('manifest.env "OPENEDBOT_BILLING_KEY" is a core variable');
    expect(invalidPluginReason(declaring([{ name: "OHB_BILLING_KEY" }]))).toBe('manifest.env "OHB_BILLING_KEY" is a core variable'); // rename:keep
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
    expect(sharedPluginEnv([billing, staff, plugin("fleet")])).toEqual([]);
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
