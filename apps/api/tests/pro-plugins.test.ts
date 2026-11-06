import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { PLUGIN_API_VERSION, type ProPlugin } from "@openedbot/platform-plugins";
import type { Db } from "@openedbot/platform-db";
import {
  guardProPlugins,
  hookEntitlementCheck,
  impersonationSourceOf,
  loadApiProPlugins,
  notifyOrganizationCreated,
  organizationCreatingHookOf,
  pluginConfig,
  pluginConfigPrefix,
  proModeLabel,
  proPluginContext,
  proPublicPathMatcher,
  proPublicRoutes,
  proSessionRoutes,
  subscriptionPortOf,
  supportDeskOf,
  supportDeskRoutes,
  tenantRoleProblem,
  type DbRoleFacts,
  type ProCaller,
} from "../src/application/pro-plugins";

/** A neutral payment webhook path a fixture billing plug-in declares (step 11.5). */
const PAY_PATH = "/api/pay/webhook";

/** A fixture plug-in shaped like an `@openedbot/pro-*` package: its routers are plain Hono apps. */
function fixturePlugin(options: { grants?: (organizationId: string) => Promise<readonly string[]> } = {}): ProPlugin {
  return {
    manifest: { id: "fixture", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: ["fixture.reports", "fixture.other"] },
    api: [
      {
        prefix: "/reports",
        access: "session",
        entitlement: "fixture.reports",
        build: (context: unknown) => new Hono<{ Bindings: Record<string, string> }>()
          .get("/", (c) => c.json({ list: true, env: c.env, context }))
          .get("/:id", (c) => c.json({ id: c.req.param("id"), organizationId: c.env.organizationId })),
      },
      {
        prefix: "/hooks",
        access: "public",
        build: () => new Hono<{ Bindings: Record<string, string> }>().post("/stripe", (c) => c.json({ received: true, env: c.env })),
      },
    ],
    hooks: { entitlementsFor: options.grants ?? (async () => ["fixture.reports"]) },
  };
}

/** The same order as `apps/api/src/index.ts`: public mounts, session middleware, session mounts, 404. */
function apiLike(plugins: readonly ProPlugin[], caller: ProCaller | undefined, check = hookEntitlementCheck(plugins)) {
  const entitled = (who: ProCaller, entitlement: string) => check(who.organizationId, entitlement);
  const app = new Hono<{ Variables: { auth?: ProCaller } }>();
  const isPublic = proPublicPathMatcher(plugins);
  const seen: string[] = [];
  if (plugins.length > 0) app.route("/", proPublicRoutes(plugins, (plugin) => ({ pluginId: plugin.manifest.id })));
  app.use("/api/*", async (context, next) => {
    if (isPublic(context.req.path)) return next();
    seen.push(context.req.path);
    if (!caller) return context.json({ error: { code: "UNAUTHENTICATED" } }, 401);
    context.set("auth", caller);
    return next();
  });
  if (plugins.length > 0) {
    app.route("/", proSessionRoutes(plugins, (plugin) => ({ pluginId: plugin.manifest.id }), {
      entitled,
      caller: (context) => (context.var as { auth?: ProCaller }).auth,
    }));
  }
  app.get("/api/bots", (c) => c.json({ core: true }));
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));
  return { app, seen };
}

const CALLER: ProCaller = { organizationId: "org-1", userId: "user-1", role: "owner" };

describe("solo mode", () => {
  test("an empty or unset OPENEDBOT_PLUGINS loads nothing and logs « mode: solo »", async () => {
    for (const value of [undefined, "", "  ", " , "]) {
      const loaded = await loadApiProPlugins(value, { importer: () => { throw new Error("must not import"); } });
      expect(loaded.plugins).toEqual([]);
      expect(loaded.skipped).toEqual([]);
      expect(proModeLabel(loaded.plugins)).toBe("mode: solo");
    }
  });

  test("no /api/pro route exists, nothing is public, core routes are unchanged", async () => {
    const { app } = apiLike([], CALLER);
    expect(proPublicPathMatcher([])("/api/pro/fixture/hooks/stripe")).toBe(false);
    expect((await app.request("/api/pro/fixture/reports")).status).toBe(404);
    expect(await (await app.request("/api/bots")).json()).toEqual({ core: true });
  });
});

describe("a fixture plug-in mounted under /api/pro/<id>", () => {
  test("the startup label names the loaded plug-ins", async () => {
    const plugin = fixturePlugin();
    const loaded = await loadApiProPlugins("@openedbot/pro-fixture, @openedbot/pro-missing", {
      importer: async (specifier) => {
        if (specifier === "@openedbot/pro-fixture") return { default: plugin };
        throw new Error("Cannot find package");
      },
    });
    expect(loaded.plugins.map((loadedPlugin) => loadedPlugin.manifest.id)).toEqual(["fixture"]);
    expect(loaded.skipped.map((skip) => skip.specifier)).toEqual(["@openedbot/pro-missing"]);
    expect(proModeLabel(loaded.plugins)).toBe("mode: pro, plugins: [fixture]");
  });

  test("a session mount is served behind the session, with the caller in env and the prefix stripped", async () => {
    const { app, seen } = apiLike([fixturePlugin()], CALLER);
    const list = await app.request("/api/pro/fixture/reports");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      list: true,
      env: {
        pluginId: "fixture",
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
        actingFleetId: null,
        organizationKind: null,
        assistedBy: null,
      },
      context: { pluginId: "fixture" },
    });
    const one = await app.request("/api/pro/fixture/reports/42");
    expect(await one.json()).toEqual({ id: "42", organizationId: "org-1" });
    expect(seen).toEqual(["/api/pro/fixture/reports", "/api/pro/fixture/reports/42"]);
  });

  test("an agency acting under a mandate reaches the plug-in with its agency in env", async () => {
    const { app } = apiLike([fixturePlugin()], { ...CALLER, role: "agency", actingFleetId: "agency-1" });
    const list = await app.request("/api/pro/fixture/reports");
    expect(((await list.json()) as { env: unknown }).env).toEqual({
      pluginId: "fixture",
      organizationId: "org-1",
      userId: "user-1",
      role: "agency",
      actingFleetId: "agency-1",
      organizationKind: null,
      assistedBy: null,
    });
  });

  test("the session's organization kind reaches the plug-in as the core read it, null when the session has none", async () => {
    for (const organizationKind of ["personal", "agency"] as const) {
      const { app } = apiLike([fixturePlugin()], { ...CALLER, organizationKind });
      const list = await app.request("/api/pro/fixture/reports");
      expect(((await list.json()) as { env: { organizationKind: unknown } }).env.organizationKind).toBe(organizationKind);
    }
    const { app } = apiLike([fixturePlugin()], { ...CALLER, organizationKind: undefined });
    const list = await app.request("/api/pro/fixture/reports");
    expect(((await list.json()) as { env: { organizationKind: unknown } }).env.organizationKind).toBeNull();
  });

  test("the assisting staff member reaches the plug-in as assistedBy (step 8d, renamed in 11.3), null otherwise", async () => {
    const impersonated = apiLike([fixturePlugin()], { ...CALLER, impersonatedByStaffUserId: "staff-1" }).app;
    const seen = await impersonated.request("/api/pro/fixture/reports");
    expect(((await seen.json()) as { env: { assistedBy: unknown } }).env.assistedBy).toBe("staff-1");
  });

  test("a session mount refuses an anonymous caller (401); without the entitlement the route does not exist (404)", async () => {
    expect((await apiLike([fixturePlugin()], undefined).app.request("/api/pro/fixture/reports")).status).toBe(401);
    const denied = apiLike([fixturePlugin({ grants: async () => [] })], CALLER).app;
    for (const path of ["/api/pro/fixture/reports", "/api/pro/fixture/reports/42"]) {
      const response = await denied.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route introuvable." } });
    }
  });

  test("a public mount is reachable without a session and skips the session middleware", async () => {
    const { app, seen } = apiLike([fixturePlugin()], undefined);
    const response = await app.request("/api/pro/fixture/hooks/stripe", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, env: { pluginId: "fixture", clientIp: null } });
    expect(seen).toEqual([]);
  });

  test("an unknown path under the plug-in stays a 404 and other plug-in ids are not routed", async () => {
    const { app } = apiLike([fixturePlugin()], CALLER);
    expect((await app.request("/api/pro/fixture/nothing")).status).toBe(404);
    expect((await app.request("/api/pro/other/reports")).status).toBe(404);
  });

  test("a mount whose build() throws is skipped with a warning; the others still mount", async () => {
    const plugin = fixturePlugin();
    const broken: ProPlugin = { ...plugin, api: [{ prefix: "/broken", access: "public", build: () => { throw new Error("boom"); } }, ...plugin.api!] };
    const warnings: unknown[] = [];
    const app = proPublicRoutes([broken], () => ({}), (event) => warnings.push(event));
    expect(warnings).toEqual([{ pluginId: "fixture", prefix: "/broken", error: "boom" }]);
    expect((await app.request("/api/pro/fixture/hooks/stripe", { method: "POST" })).status).toBe(200);
  });
});

describe("hooks", () => {
  test("entitlementsFor grants only the plug-in's own declared entitlements; a failing hook grants nothing", async () => {
    const greedy = fixturePlugin({ grants: async () => ["fixture.reports", "fleet.workspaces"] });
    const check = hookEntitlementCheck([greedy]);
    expect(await check("org-1", "fixture.reports")).toBe(true);
    expect(await check("org-1", "fleet.workspaces")).toBe(false);
    const warnings: unknown[] = [];
    const failing = hookEntitlementCheck([fixturePlugin({ grants: async () => { throw new Error("db down"); } })], (event) => warnings.push(event));
    expect(await failing("org-1", "fixture.reports")).toBe(false);
    expect(warnings).toEqual([{ pluginId: "fixture", error: "db down" }]);
  });

  test("notifyOrganizationCreated calls every hook and never throws", async () => {
    const calls: string[] = [];
    const ok: ProPlugin = { ...fixturePlugin(), hooks: { onOrganizationCreated: async (id) => { calls.push(id); } } };
    const failing: ProPlugin = {
      manifest: { id: "failing", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
      hooks: { onOrganizationCreated: async () => { throw new Error("nope"); } },
    };
    const warnings: unknown[] = [];
    await notifyOrganizationCreated([failing, ok], "org-9", (event) => warnings.push(event));
    expect(calls).toEqual(["org-9"]);
    expect(warnings).toEqual([{ pluginId: "failing", error: "nope" }]);
  });
});

describe("plug-in context", () => {
  const ENV = {
    OPENEDBOT_PLUGIN_FIXTURE__API_KEY: "k1",
    OPENEDBOT_PLUGIN_FIXTURE__WEBHOOK_SECRET: "s1",
    OPENEDBOT_PLUGIN_FIXTURE_LEGACY: "no double underscore",
    OPENEDBOT_PLUGIN_FIXTURE__BAD__KEY: "nested",
    OPENEDBOT_PLUGIN_OTHER__API_KEY: "other plug-in",
    OPENEDBOT_PLUGINS: "@openedbot/pro-fixture",
    API_DATABASE_URL: "postgres://core-only",
    STRIPE_SECRET_KEY: "core-only",
    OPENEDBOT_PLUGIN_FIXTURE__EMPTY: undefined,
  };

  test("config holds only the plug-in's own OPENEDBOT_PLUGIN_<ID>__<KEY> variables, keyed by <KEY>", () => {
    expect(pluginConfigPrefix("fixture")).toBe("OPENEDBOT_PLUGIN_FIXTURE__");
    expect(pluginConfigPrefix("audit-log")).toBe("OPENEDBOT_PLUGIN_AUDIT_LOG__");
    expect(pluginConfig("fixture", ENV)).toEqual({ API_KEY: "k1", WEBHOOK_SECRET: "s1" });
    expect(Object.isFrozen(pluginConfig("fixture", ENV))).toBe(true);
    expect(pluginConfig("nothing", ENV)).toEqual({});
  });

  test("a plug-in never reads the variables of an id that extends its own", () => {
    const env = { "OPENEDBOT_PLUGIN_A__B__TOKEN": "belongs to a--b", OPENEDBOT_PLUGIN_A__TOKEN: "belongs to a" };
    expect(pluginConfig("a", env)).toEqual({ TOKEN: "belongs to a" });
    expect(pluginConfig("a--b", env)).toEqual({ TOKEN: "belongs to a--b" });
  });

  test("a mount's build() receives the pool and its scoped config, never the whole environment", async () => {
    const db = {} as Db;
    let received: unknown;
    const plugin = fixturePlugin();
    const spy: ProPlugin = { ...plugin, api: [{ prefix: "/spy", access: "public", build: (context) => { received = context; return new Hono(); } }] };
    proPublicRoutes([spy], (loaded) => proPluginContext(loaded, db, ENV));
    expect(received).toEqual({ pluginId: "fixture", db, config: { API_KEY: "k1", WEBHOOK_SECRET: "s1" } });
    expect(JSON.stringify(Object.keys((received as { config: object }).config))).not.toContain("STRIPE");
  });

  const appRole: DbRoleFacts = { role: "openedbot_api", superuser: false, bypassRls: false, ownsTables: false };
  type Row = Omit<DbRoleFacts, "memberOf"> & { current?: boolean };
  /** Rows as the catalog query returns them: the pool's role flagged `current`, then its granted roles. */
  const fakeDb = (rows: Row[] | Error) => (async () => {
    if (rows instanceof Error) throw rows;
    return rows.map((row, index) => ({ current: index === 0, ...row }));
  }) as unknown as Db;

  test("the database handle must stay under row-level security: superuser, BYPASSRLS and table owners are refused", () => {
    expect(tenantRoleProblem(appRole)).toBeNull();
    expect(tenantRoleProblem({ ...appRole, role: "postgres", superuser: true })).toBe("role postgres is a superuser");
    expect(tenantRoleProblem({ ...appRole, bypassRls: true })).toBe("role openedbot_api has BYPASSRLS");
    expect(tenantRoleProblem({ ...appRole, role: "openedbot_migrator", ownsTables: true })).toBe("role openedbot_migrator owns tables");
  });

  test("an inherited membership counts: a granted owner, superuser or BYPASSRLS role is refused", () => {
    const granted = (role: string, attributes: Partial<DbRoleFacts>) => ({ ...appRole, role, ...attributes });
    expect(tenantRoleProblem({ ...appRole, memberOf: [granted("openedbot_readers", {})] })).toBeNull();
    expect(tenantRoleProblem({ ...appRole, memberOf: [granted("openedbot_readers", {}), granted("openedbot_migrator", { ownsTables: true })] }))
      .toBe("role openedbot_api is a member of openedbot_migrator, which owns tables");
    expect(tenantRoleProblem({ ...appRole, memberOf: [granted("postgres", { superuser: true })] }))
      .toBe("role openedbot_api is a member of postgres, which is a superuser");
    expect(tenantRoleProblem({ ...appRole, memberOf: [granted("openedbot_ops", { bypassRls: true })] }))
      .toBe("role openedbot_api is a member of openedbot_ops, which has BYPASSRLS");
  });

  test("readDbRoleFacts follows pg_auth_members and splits the pool's role from the granted ones", async () => {
    const { readDbRoleFacts } = await import("../src/application/pro-plugins");
    let query = "";
    const db = (async (strings: TemplateStringsArray) => {
      query = strings.join(" ");
      return [
        { role: "openedbot_api", superuser: false, bypassRls: false, ownsTables: false, current: true },
        { role: "openedbot_migrator", superuser: false, bypassRls: false, ownsTables: true, current: false },
      ];
    }) as unknown as Db;
    const facts = await readDbRoleFacts(db);
    expect(facts).toEqual({ ...appRole, memberOf: [{ ...appRole, role: "openedbot_migrator", ownsTables: true }] });
    expect(query).toContain("with recursive");
    expect(query).toContain("pg_auth_members");
    expect(query).not.toMatch(/\b(insert|update|delete|create|alter|drop|grant|revoke|set role)\b/i);
    expect(tenantRoleProblem(facts)).toBe("role openedbot_api is a member of openedbot_migrator, which owns tables");
  });

  test("guardProPlugins keeps the plug-ins under the app role, and drops them all otherwise", async () => {
    const plugins = [fixturePlugin()];
    const refused: string[] = [];
    expect(await guardProPlugins(plugins, fakeDb([appRole]), (reason) => refused.push(reason))).toBe(plugins);
    expect(await guardProPlugins(plugins, fakeDb([{ ...appRole, role: "openedbot_migrator", ownsTables: true }]), (reason) => refused.push(reason))).toEqual([]);
    expect(await guardProPlugins(plugins, fakeDb([appRole, { ...appRole, role: "openedbot_migrator", ownsTables: true }]), (reason) => refused.push(reason))).toEqual([]);
    expect(await guardProPlugins(plugins, fakeDb(new Error("connection refused")), (reason) => refused.push(reason))).toEqual([]);
    expect(await guardProPlugins(plugins, fakeDb([]), (reason) => refused.push(reason))).toEqual([]);
    expect(refused).toEqual([
      "role openedbot_migrator owns tables",
      "role openedbot_api is a member of openedbot_migrator, which owns tables",
      "role check failed: connection refused",
      "role check failed: current_user has no pg_roles row",
    ]);
  });

  test("solo mode runs no role query at all", async () => {
    const db = (() => { throw new Error("must not query"); }) as unknown as Db;
    expect(await guardProPlugins([], db, () => { throw new Error("must not refuse"); })).toEqual([]);
  });
});

describe("onOrganizationCreated, wired like apps/api/src/index.ts", () => {
  test("a plug-in hook that throws is logged; the organization is still created and the other hooks still run", async () => {
    const { installOrganizationCreatedListener } = await import("@openedbot/identity/application/organization-created");
    const { createOrganization } = await import("@openedbot/identity/application/accounts");
    const order: string[] = [];
    const warnings: unknown[] = [];
    const throwing: ProPlugin = { ...fixturePlugin(), hooks: { onOrganizationCreated: async () => { order.push("throwing"); throw new Error("pro down"); } } };
    const healthy: ProPlugin = {
      manifest: { id: "other", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
      hooks: { onOrganizationCreated: async (id) => { order.push(`other:${id}`); } },
    };
    installOrganizationCreatedListener((id) => notifyOrganizationCreated([throwing, healthy], id, (event) => warnings.push(event)));
    try {
      const tx = async () => [];
      const db = { begin: async (callback: (t: typeof tx) => Promise<unknown>) => { const result = await callback(tx); order.push("commit"); return result; } } as unknown as Db;
      const created = await createOrganization(db, { kind: "agency", name: "Agence" }, "user-1", "test", false);
      expect(order).toEqual(["commit", "throwing", `other:${created.organizationId}`]);
      expect(warnings).toEqual([{ pluginId: "fixture", error: "pro down" }]);
    } finally {
      installOrganizationCreatedListener(null);
    }
  });
});

describe("onOrganizationCreating (step 8d), wired like apps/api/src/index.ts", () => {
  const billing = (onOrganizationCreating: NonNullable<NonNullable<ProPlugin["hooks"]>["onOrganizationCreating"]>): ProPlugin => ({
    manifest: { id: "billing", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: ["billing.enforced"] },
    hooks: { onOrganizationCreating },
  });

  test("solo, or no plug-in billing: no hook, nothing to install", () => {
    expect(organizationCreatingHookOf([])).toBeNull();
    expect(organizationCreatingHookOf([fixturePlugin()])).toBeNull();
  });

  test("the plug-in billing's hook gets the creation transaction, the event and only its own configuration", async () => {
    const seen: unknown[] = [];
    const hook = organizationCreatingHookOf([fixturePlugin(), billing(async (tx, event, context) => { seen.push([tx, event, context]); })], {
      OPENEDBOT_PLUGIN_BILLING__PLAN: "solo",
      OPENEDBOT_PLUGIN_FIXTURE__KEY: "nope",
      STRIPE_SECRET_KEY: "nope",
    });
    const event = { organizationId: "org-1", kind: "personal", billingEnforced: true, environment: "production" } as const;
    await hook!("tx", event);
    expect(seen).toEqual([["tx", event, { config: { PLAN: "solo" } }]]);
  });

  test("a throwing hook rolls the creation back through identity (nothing is swallowed here)", async () => {
    const { installOrganizationCreatingListener, OrganizationCreatingError } = await import("@openedbot/identity/application/organization-creating");
    const { createOrganization } = await import("@openedbot/identity/application/accounts");
    const order: string[] = [];
    installOrganizationCreatingListener(organizationCreatingHookOf([billing(async () => { throw new Error("stripe down"); })]));
    try {
      const tx = async () => [];
      const db = { begin: async (callback: (t: typeof tx) => Promise<unknown>) => {
        try { const result = await callback(tx); order.push("commit"); return result; } catch (error) { order.push("rollback"); throw error; }
      } } as unknown as Db;
      await expect(createOrganization(db, { kind: "agency", name: "Agence" }, "user-1", "test", false)).rejects.toBeInstanceOf(OrganizationCreatingError);
      expect(order).toEqual(["rollback"]);
    } finally {
      installOrganizationCreatingListener(null);
    }
  });
});

describe("plug-in audit (étape 5) : export de preuve sous /api/pro/audit", () => {
  /** Shaped like `@openedbot/pro-audit`: one session mount at `/`, gated by `audit.anchor`, granted from its config. */
  function auditFixture(): ProPlugin {
    return {
      manifest: { id: "audit", version: "0.1.0", pluginApi: PLUGIN_API_VERSION, entitlements: ["audit.anchor"] },
      api: [{
        prefix: "/",
        access: "session",
        entitlement: "audit.anchor",
        build: () => ({
          fetch: (request: Request, env: unknown) => Response.json({ path: new URL(request.url).pathname, env }),
        }),
      }],
      hooks: {
        entitlementsFor: async (organizationId, context) =>
          (context?.config.ANCHOR_ORGANIZATIONS ?? "").split(",").map((id) => id.trim()).includes(organizationId) ? ["audit.anchor"] : [],
      },
    };
  }

  test("sans l'entitlement audit.anchor : 404, la route n'existe pas pour l'organisation", async () => {
    const plugins = [auditFixture()];
    const { app } = apiLike(plugins, CALLER, hookEntitlementCheck(plugins, undefined, {}));
    for (const path of ["/api/pro/audit", "/api/pro/audit/proof?runtimeId=rt-1"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    }
  });

  test("avec l'entitlement (accordé par la config du plug-in, par organisation) : le routeur répond", async () => {
    const plugins = [auditFixture()];
    const env = { OPENEDBOT_PLUGIN_AUDIT__ANCHOR_ORGANIZATIONS: "org-0, org-1", OPENEDBOT_PLUGIN_OTHER__ANCHOR_ORGANIZATIONS: "org-2" };
    const { app } = apiLike(plugins, CALLER, hookEntitlementCheck(plugins, undefined, env));
    const response = await app.request("/api/pro/audit/proof?runtimeId=rt-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: "/proof", env: { pluginId: "audit", organizationId: "org-1" } });
    const other = apiLike(plugins, { ...CALLER, organizationId: "org-2" }, hookEntitlementCheck(plugins, undefined, env));
    expect((await other.app.request("/api/pro/audit/proof")).status).toBe(404);
  });
});

describe("public mounts: the caller's address", () => {
  test("reads the last X-Forwarded-For hop only behind a trusted proxy", async () => {
    const request = () => new Request("http://api.test/api/pro/fixture/hooks/stripe", {
      method: "POST",
      headers: { "X-Forwarded-For": "198.51.100.1, 203.0.113.7" },
    });
    const trusted = proPublicRoutes([fixturePlugin()], () => ({}), undefined, { trustProxy: true });
    expect(await (await trusted.fetch(request())).json()).toEqual({
      received: true,
      env: { pluginId: "fixture", clientIp: "203.0.113.7" },
    });
    const untrusted = proPublicRoutes([fixturePlugin()], () => ({}));
    expect(await (await untrusted.fetch(request())).json()).toEqual({
      received: true,
      env: { pluginId: "fixture", clientIp: null },
    });
  });
});

describe("impersonationSourceOf", () => {
  const plugin = (id: string, impersonation?: ProPlugin["impersonation"]): ProPlugin => ({
    manifest: { id, version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
    ...(impersonation ? { impersonation } : {}),
  });

  test("solo and plug-ins without a source: none", () => {
    expect(impersonationSourceOf([])).toBeNull();
    expect(impersonationSourceOf([plugin("audit")])).toBeNull();
  });

  test("keeps the first source and reports the others", () => {
    const first = { claim: async () => null };
    const second = { claim: async () => null };
    const warnings: unknown[] = [];
    expect(impersonationSourceOf([plugin("audit"), plugin("staff", first), plugin("other", second)], (event) => warnings.push(event))).toBe(first);
    expect(warnings).toEqual([{ pluginId: "other", keptPluginId: "staff" }]);
  });
});

describe("support desk port (step 11.3)", () => {
  const plugin = (id: string, supportDesk?: ProPlugin["supportDesk"]): ProPlugin => ({
    manifest: { id, version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
    ...(supportDesk ? { supportDesk } : {}),
  });
  const echo = (label: string) => ({
    build: (context: unknown) => new Hono<{ Bindings: { clientIp: string | null } }>()
      .all("*", (c) => c.json({ label, path: c.req.path, clientIp: c.env.clientIp, context })),
  });
  const request = (path: string, headers: Record<string, string> = {}) => new Request(`http://local${path}`, { method: "POST", headers });

  test("solo and plug-ins without a desk: none", () => {
    expect(supportDeskOf([])).toBeNull();
    expect(supportDeskOf([plugin("audit")])).toBeNull();
  });

  test("keeps the first desk and reports the others", () => {
    const first = echo("first");
    const warnings: unknown[] = [];
    expect(supportDeskOf([plugin("audit"), plugin("staff", first), plugin("other", echo("second"))], (event) => warnings.push(event))?.desk).toBe(first);
    expect(warnings).toEqual([{ pluginId: "other", keptPluginId: "staff" }]);
  });

  test("without a desk every /api/support path is the core 404 NOT_FOUND, other paths are untouched", async () => {
    const app = new Hono().route("/", supportDeskRoutes(null, () => ({})));
    app.get("/api/health", (c) => c.text("ok"));
    for (const path of ["/api/support", "/api/support/conversations", "/api/support/conversations/x/events"]) {
      const response = await app.fetch(request(path));
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    }
    expect((await app.fetch(new Request("http://local/api/health"))).status).toBe(200);
    expect((await app.fetch(new Request("http://local/api/supportx"))).status).toBe(404);
  });

  test("with a desk the provider gets the path below /api/support, its context and the client address", async () => {
    const app = new Hono().route("/", supportDeskRoutes(supportDeskOf([plugin("staff", echo("desk"))]), (entry) => ({ for: entry.manifest.id }), undefined, { trustProxy: true }));
    const response = await app.fetch(request("/api/support/conversations", { "x-forwarded-for": "203.0.113.9" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ label: "desk", path: "/conversations", clientIp: "203.0.113.9", context: { for: "staff" } });
  });

  test("a desk whose build() throws is reported and falls back to the 404", async () => {
    const warnings: unknown[] = [];
    const broken = { build: () => { throw new Error("boom"); } };
    const app = new Hono().route("/", supportDeskRoutes(supportDeskOf([plugin("staff", broken)]), () => ({}), (event) => warnings.push(event)));
    expect((await app.fetch(request("/api/support/conversations"))).status).toBe(404);
    expect(warnings.length).toBe(1);
  });
});

describe("subscriptionPortOf (step 8d)", () => {
  const port = { memberLimit: async () => 3, status: async () => null, read: async () => null, readForUpdate: async () => null, admission: () => null };
  const billingPlugin = (id: string): ProPlugin => ({
    manifest: { id, version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
    billing: { webhookPath: PAY_PATH, webhook: async () => new Response(null), subscriptions: port },
  });

  test("solo, or billing without a port: null (the core installs NO_SUBSCRIPTIONS)", () => {
    expect(subscriptionPortOf([])).toBeNull();
    expect(subscriptionPortOf([{ ...billingPlugin("billing"), billing: { webhookPath: PAY_PATH, webhook: async () => new Response(null) } }])).toBeNull();
  });

  test("the port of the plug-in billing, and of no other id", () => {
    expect(subscriptionPortOf([billingPlugin("billing")]) as unknown).toBe(port);
    expect(subscriptionPortOf([billingPlugin("staff")])).toBeNull();
  });
});
