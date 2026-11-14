/**
 * Pro mode: the plug-ins listed in `OPENEDBOT_PLUGINS` (absolute paths into a
 * local plug-in checkout, see `make test-dual`) load and mount like in
 * production. Skipped in solo (unset), so `make test-unit` never needs any
 * external plug-in.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Db } from "@openedbot/platform-db";
import type { PluginSkip, ProPlugin } from "@openedbot/platform-plugins";
import { compatPathAliasesOf, declaredEntitlements, parsePluginList } from "@openedbot/platform-plugins";
import { shadowsCoreRoute } from "../src/application/compat-aliases";
import { authRoutes, protectedAuthRoutes } from "../src/routes/identity/auth";
import { miscRoutes } from "../src/routes/overview/misc-routes";
import { searchRoutes } from "../src/routes/conversation/search-routes";
import { inboxRoutes } from "../src/routes/inbox/inbox-routes";
import { memberRoutes } from "../src/routes/identity/member-routes";
import { createEntitlementSource, PRO_ENTITLEMENTS } from "@openedbot/identity/application/entitlements";
import { removedApiRoutes } from "../src/routes/platform/removed-routes";
import { hookEntitlementCheck, loadApiProPlugins, organizationCreatingHookOf, proPluginContext, proPublicPathMatcher, proPublicRoutes, proSessionRoutes, paymentWebhookMountOf, paymentWebhookOf, subscriptionPortOf, type ProCaller } from "../src/application/pro-plugins";
import { paymentWebhookRoute } from "../src/routes/payments/payment-webhook-route";
import type { ApiConfig } from "../src/infrastructure/config";
import { HttpError } from "../src/interfaces/http/http-error";

const listed = parsePluginList(process.env.OPENEDBOT_PLUGINS);
const skipped: PluginSkip[] = [];
const { plugins } = await loadApiProPlugins(process.env.OPENEDBOT_PLUGINS, { warn: (skip) => skipped.push(skip) });
const staff = plugins.filter((plugin) => plugin.manifest.id === "staff");
const permissions = plugins.filter((plugin) => plugin.manifest.id === "permissions");
const billing = plugins.filter((plugin) => plugin.manifest.id === "billing");

const db = {} as Db;
const unused = () => {
  throw new Error("not used by this test");
};
const staffHost = {
  config: { environment: "test", trustProxy: false, staffDevSignIn: null, webUrl: "https://app.openedbot.test", billingEnforced: false },
  blobs: {},
  session: { optional: async () => null },
  services: {
    sse: { createOrderedReplayPump: unused, replayPagesUntil: unused, shouldEmitSseCursor: unused },
    normalizeOperationalMetrics: unused,
  },
};

/** The order of `apps/api/src/index.ts`: the core error handler and 404 around the public plug-in mounts. */
function apiLike(loaded: readonly ProPlugin[], hosts: Record<string, unknown>, warnings: unknown[] = [], sessionCheck = false) {
  const app = new Hono();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "INTERNAL_ERROR" } }, 500));
  app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
  app.route("/", proPublicRoutes(loaded, (plugin) => proPluginContext(plugin, db, {}, hosts), (event) => warnings.push(event)));
  app.route("/", removedApiRoutes());
  if (sessionCheck) app.use("/api/*", async (context) => context.json({ error: { code: "AUTH_REQUIRED", message: "Authentification requise." } }, 401));
  return app;
}

describe.skipIf(listed.length === 0)("pro mode (OPENEDBOT_PLUGINS)", () => {
  // Step 11.4: the runtime drops an alias over a core route; this pins that
  // none of the published ones would be dropped. Every router `index.ts`
  // mounts over an alias's path must be in the table, or the test fails.
  test("no plug-in path alias shadows a core route", async () => {
    const config = {
      environment: "test", deployEnvironment: "dev", webUrl: "https://app.openedbot.test", trustProxy: false,
      google: { clientId: null, clientSecret: null, allowedEmails: new Set<string>() }, nativeRedirectUris: [], devSignIn: null,
    } as unknown as ApiConfig;
    const routers: Record<string, Array<() => Hono<never>>> = {
      "/api": [() => miscRoutes(db, config) as never, () => searchRoutes(db) as never, () => inboxRoutes(db) as never],
      "/api/auth": [() => authRoutes(db, config) as never, () => protectedAuthRoutes(db) as never],
      "/api/organization": [() => memberRoutes(db, config) as never],
    };
    const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const mounts = [...index.matchAll(/app\.route\("(\/[^"]*)"/g)].map((match) => match[1]!);
    const under = (path: string, root: string) => root === "/" || path === root || path.startsWith(`${root}/`);
    const paths = compatPathAliasesOf(plugins);
    for (const alias of paths) {
      const covering = mounts.filter((mount) => mount !== "/" && under(alias.from, mount));
      for (const mount of new Set(covering)) {
        expect([alias.from, mount, routers[mount]?.length ?? 0]).toEqual([alias.from, mount, covering.filter((m) => m === mount).length]);
      }
      const core = new Hono();
      for (const mount of new Set(covering)) for (const build of routers[mount]!) core.route(mount, build());
      core.route("/", removedApiRoutes());
      expect([alias.from, shadowsCoreRoute(alias.from, core.routes)]).toEqual([alias.from, false]);
    }
  });

  test("every listed plug-in loads, none skipped", () => {
    expect(skipped).toEqual([]);
    expect(plugins.length).toBe(listed.length);
  });

  describe.skipIf(staff.length === 0)("the staff plug-in from the external plug-ins", () => {
    test("serves /api/pro/staff", async () => {
      expect(proPublicPathMatcher(staff)("/api/pro/staff/login")).toBe(true);
      expect(proPublicPathMatcher(staff)("/api/pro/staffing")).toBe(false);
    });

    test("the core error shape and 404 around its routes", async () => {
      const app = apiLike(staff, { staff: staffHost });
      const providers = await app.request("/api/pro/staff/providers");
      expect(providers.status).toBe(200);
      expect(providers.headers.get("Cache-Control")).toBe("no-store");
      expect(await providers.json()).toEqual({});
      const invalid = await app.request("/api/pro/staff/login/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "L’adresse email est invalide." } });
      const anonymous = await app.request("/api/pro/staff/me");
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: { code: "AUTH_REQUIRED", message: "Authentification requise." } });
      const outside = await app.request("/api/pro/staffing");
      expect(outside.status).toBe(404);
      expect(await outside.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route introuvable." } });
    });

    test("without its host services it is skipped, never half-mounted", async () => {
      const warnings: Array<{ pluginId: string; error: string }> = [];
      const app = apiLike(staff, {}, warnings);
      expect(warnings.map((warning) => warning.pluginId)).toEqual(["staff"]);
      expect(warnings[0]?.error).toContain("host services");
      expect((await app.request("/api/pro/staff/providers")).status).toBe(404);
    });

    test("the former /api/staff root stays 404, before any session check", async () => {
      const app = apiLike(staff, { staff: staffHost }, [], true);
      expect((await app.request("/api/pro/staff/providers")).status).toBe(200);
      for (const path of ["/api/staff", "/api/staff/providers", "/api/staff/me"]) {
        expect((await app.request(path, { headers: { Cookie: "openedbot_staff_session=x" } })).status).toBe(404);
      }
    });
  });

  describe.skipIf(permissions.length === 0)("the permissions plug-in from the external plug-ins (step 8b)", () => {
    const ORG = "11111111-1111-4111-8111-111111111111";
    /** The order of `apps/api/src/index.ts`: session mounts behind the caller, the core error handler and 404. */
    function sessionApi(caller: ProCaller) {
      const app = new Hono();
      app.onError((error, context) => error instanceof HttpError
        ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
        : context.json({ error: { code: "INTERNAL_ERROR" } }, 500));
      app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
      const entitled = async ({ organizationId }: ProCaller, entitlement: string) => {
        const source = createEntitlementSource({
          features: async () => ({ connectorOnlyEnrollment: false }),
          billingEnforced: false,
          pro: { declared: declaredEntitlements(permissions), grant: hookEntitlementCheck(permissions) },
        });
        return source.has(entitlement, { organizationId });
      };
      app.route("/", proSessionRoutes(permissions, (plugin) => proPluginContext(plugin, db, {}, {}), { entitled, caller: () => caller }));
      return app;
    }

    test("serves the rule editing under /api/pro/permissions for every organization, with the core's codes", async () => {
      const app = sessionApi({ organizationId: ORG, userId: ORG, role: "owner" });
      const invalid = await app.request("/api/pro/permissions/bots/not-a-uuid/rules");
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: { code: "ID_INVALID", message: "Identifiant invalide." } });
      const member = sessionApi({ organizationId: ORG, userId: ORG, role: "member" });
      const refused = await member.request(`/api/pro/permissions/bots/${ORG}/rules`, { method: "POST", body: "{}" });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: { code: "ROLE_REQUIRED", message: "Droits insuffisants." } });
    });

    test("it provides no rule source and never grants permissions.v2: the worker keeps the core rules", async () => {
      expect(permissions[0]?.permissionRules).toBeUndefined();
      expect(await hookEntitlementCheck(permissions)(ORG, "permissions.v2")).toBe(false);
    });
  });

  describe.skipIf(billing.length === 0)("the billing plug-in from the external plug-ins (step 8d)", () => {
    const ORG = "11111111-1111-4111-8111-111111111111";
    const billingHost = (billingEnforced: boolean) => ({
      config: { webUrl: "https://app.openedbot.test", billingEnforced, billingGraceDays: 30, plan: { runtimeLimit: 1, memberLimit: 1, concurrentRunLimit: 1, attachmentQuotaBytes: 1 }, billingPriceEur: 19 },
    });
    function sessionApi(caller: ProCaller, billingEnforced: boolean) {
      const app = new Hono();
      app.onError((error, context) => error instanceof HttpError
        ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
        : context.json({ error: { code: "INTERNAL_ERROR" } }, 500));
      app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
      const source = createEntitlementSource({
        features: async () => ({ connectorOnlyEnrollment: false }),
        billingEnforced,
        pro: { declared: declaredEntitlements(plugins), grant: hookEntitlementCheck(plugins) },
      });
      const entitled = ({ organizationId }: ProCaller, entitlement: string) => source.has(entitlement, { organizationId });
      app.route("/", proSessionRoutes(billing, (plugin) => proPluginContext(plugin, db, {}, { billing: billingHost(billingEnforced) }), { entitled, caller: () => caller }));
      return app;
    }

    test("it alone declares billing.enforced, and the paywall holds only with BILLING_ENFORCED", async () => {
      expect(billing[0]?.manifest.entitlements).toEqual(["billing.enforced"]);
      expect(plugins.filter((plugin) => plugin.manifest.entitlements.includes(PRO_ENTITLEMENTS.billingEnforced)).map((plugin) => plugin.manifest.id)).toEqual(["billing"]);
      for (const billingEnforced of [false, true]) {
        const source = createEntitlementSource({
          features: async () => ({ connectorOnlyEnrollment: false }),
          billingEnforced,
          pro: { declared: declaredEntitlements(plugins), grant: async () => false },
        });
        expect(await source.has(PRO_ENTITLEMENTS.billingEnforced)).toBe(billingEnforced);
      }
    });

    test("provides the subscription port and the creation hook", () => {
      expect(subscriptionPortOf(billing)).not.toBeNull();
      expect(organizationCreatingHookOf(billing)).not.toBeNull();
      expect(subscriptionPortOf(plugins.filter((plugin) => plugin.manifest.id !== "billing"))).toBeNull();
    });

    test("serves /api/pro/billing behind billing.enforced, owner-only writes with the core's codes", async () => {
      const owner = { organizationId: ORG, userId: ORG, role: "owner" };
      expect((await sessionApi(owner, false).request("/api/pro/billing/subscription")).status).toBe(404);
      const member = await sessionApi({ ...owner, role: "member" }, true).request("/api/pro/billing/checkout", { method: "POST" });
      expect(member.status).toBe(403);
      expect(await member.json()).toEqual({ error: { code: "ROLE_REQUIRED", message: "Droits insuffisants." } });
      const unconfigured = await sessionApi(owner, true).request("/api/pro/billing/checkout", { method: "POST" });
      expect(unconfigured.status).toBe(503);
      expect(((await unconfigured.json()) as { error: { code: string } }).error.code).toBe("STRIPE_NOT_CONFIGURED");
    });

    test("answers its webhook at the path it declares: without a secret, 503 before any query", async () => {
      const app = new Hono();
      app.onError((error, context) => error instanceof HttpError
        ? context.json({ error: { code: error.code } }, error.status as 400)
        : context.json({ error: { code: "INTERNAL_ERROR" } }, 500));
      const config = { billingPriceEur: 19 } as unknown as ApiConfig;
      const mount = paymentWebhookMountOf(billing, billing, {});
      expect(mount?.delegate).toBeFunction();
      expect(paymentWebhookOf(billing)).toBeFunction();
      expect(mount!.path).toMatch(/^\/api\//);
      app.route(mount!.path, paymentWebhookRoute(db, config, mount!.delegate));
      const response = await app.request(mount!.path, { method: "POST", body: "{}" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "STRIPE_NOT_CONFIGURED" } });
    });
  });
});
