import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { PLUGIN_API_VERSION, type ProPlugin } from "@openedbot/platform-plugins";
import type { Db } from "@openedbot/platform-db";
import { LEGACY_PLUGIN_SPECIFIERS, loadLegacyPlugins } from "../src/application/legacy-plugins";
import { removedApiRoutes } from "../src/routes/platform/removed-routes";
import { impersonationSourceOf, proPluginContext, proPublicPathMatcher, proPublicRoutes } from "../src/application/pro-plugins";
import { HttpError } from "../src/interfaces/http/http-error";

const db = {} as Db;
const unused = () => {
  throw new Error("not used by this test");
};
/** The `StaffHost` the API lends the `staff` plug-in (`proHosts().staff`), with unused services. */
const staffHost = {
  config: { environment: "test", trustProxy: false, staffDevSignIn: null, webUrl: "https://app.ohb.test", billingEnforced: false, support: { pollMs: 1_000 } },
  supportHub: {},
  blobs: {},
  services: {
    support: { readAttachments: unused, serveAttachment: unused, eventStream: unused, typingEvent: unused, wakePumps: unused },
    normalizeOperationalMetrics: unused,
  },
};

/** The order of `apps/api/src/index.ts`: the core error handler and 404 around the public plug-in mounts. */
function apiLike(plugins: readonly ProPlugin[], hosts: Record<string, unknown>, warnings: unknown[] = [], sessionCheck = false) {
  const app = new Hono();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "INTERNAL_ERROR" } }, 500));
  app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
  app.route("/", proPublicRoutes(plugins, (plugin) => proPluginContext(plugin, db, {}, hosts), (event) => warnings.push(event)));
  app.route("/", removedApiRoutes());
  // The core session check, after the public mounts: anything left is 401.
  if (sessionCheck) app.use("/api/*", async (context) => context.json({ error: { code: "AUTH_REQUIRED", message: "Authentification requise." } }, 401));
  return app;
}

/** A public plug-in standing in for the backoffice: the core side of the mount, without any external plug-in. */
const fakeStaff: ProPlugin<Hono> = {
  manifest: { id: "staff", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
  api: [{
    prefix: "/",
    access: "public",
    build: (context) => {
      if (!(context as { host?: Record<string, unknown> }).host?.staff) throw new Error("staff plug-in needs its host services");
      const router = new Hono();
      router.get("/providers", (c) => c.json({}, 200, { "Cache-Control": "no-store" }));
      router.post("/login/code", () => {
        throw new HttpError(400, "VALIDATION_ERROR", "L’adresse email est invalide.");
      });
      router.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
      router.onError((error) => {
        throw error;
      });
      return router;
    },
  }],
};

describe("legacy install", () => {
  test("empty since step 8: the backoffice comes from an external plug-in through OPENEDBOT_PLUGINS", async () => {
    expect(LEGACY_PLUGIN_SPECIFIERS).toEqual([]);
    expect(await loadLegacyPlugins([])).toEqual([]);
  });

  test("a plug-in already loaded by OPENEDBOT_PLUGINS is not installed twice", async () => {
    const loaded: ProPlugin = { manifest: { id: "staff", version: "2.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] } };
    const superseded: unknown[] = [];
    const importer = async () => ({ default: fakeStaff });
    expect(await loadLegacyPlugins([loaded], { superseded: (event) => superseded.push(event) }, ["legacy-staff"], importer)).toEqual([]);
    expect(superseded).toEqual([{ pluginId: "staff", specifier: "legacy-staff" }]);
    expect((await loadLegacyPlugins([], {}, ["legacy-staff"], importer)).map((plugin) => plugin.manifest.id)).toEqual(["staff"]);
  });

  test("absent from the image: skipped with a warning, the API runs solo", async () => {
    const skipped: Array<{ specifier: string; reason: string }> = [];
    expect(await loadLegacyPlugins([], { skipped: (skip) => skipped.push(skip) }, ["@openedbot/absent-legacy/plugin"])).toEqual([]);
    expect(skipped.map((skip) => skip.specifier)).toEqual(["@openedbot/absent-legacy/plugin"]);
    expect(skipped[0]?.reason).toContain("cannot import");
  });

  test("the former @openedbot/staff is not installed in the core any more", async () => {
    const skipped: Array<{ specifier: string; reason: string }> = [];
    expect(await loadLegacyPlugins([], { skipped: (skip) => skipped.push(skip) }, ["@openedbot/staff/plugin"])).toEqual([]);
    expect(skipped[0]?.reason).toContain("cannot import");
  });
});

describe("public plug-in mounts (core side, a stand-in backoffice)", () => {
  test("serves /api/pro/staff with the core error shape and 404", async () => {
    const plugins = [fakeStaff as ProPlugin];
    expect(proPublicPathMatcher(plugins)("/api/pro/staff/login")).toBe(true);
    expect(proPublicPathMatcher(plugins)("/api/pro/staffing")).toBe(false);
    const app = apiLike(plugins, { staff: staffHost });
    const providers = await app.request("/api/pro/staff/providers");
    expect(providers.status).toBe(200);
    expect(providers.headers.get("Cache-Control")).toBe("no-store");
    expect(await providers.json()).toEqual({});
    const invalid = await app.request("/api/pro/staff/login/code", { method: "POST" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "L’adresse email est invalide." } });
    const outside = await app.request("/api/pro/staffing");
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route introuvable." } });
  });

  test("a plug-in whose build throws is skipped, never half-mounted", async () => {
    const warnings: Array<{ pluginId: string; error: string }> = [];
    const app = apiLike([fakeStaff as ProPlugin], {}, warnings);
    expect(warnings.map((warning) => warning.pluginId)).toEqual(["staff"]);
    expect(warnings[0]?.error).toContain("host services");
    expect((await app.request("/api/pro/staff/providers")).status).toBe(404);
  });

  test("a plug-in only sees its own host entry", () => {
    const other: ProPlugin = { manifest: { id: "audit", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] } };
    expect(proPluginContext(other, db, {}, { staff: staffHost }).host).toBeUndefined();
    const staff: ProPlugin = { manifest: { id: "staff", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] } };
    expect(proPluginContext(staff, db, {}, { staff: staffHost, audit: {} }).host).toEqual({ staff: staffHost });
  });

  test("the former /api/staff root is gone: 404 with a backoffice mounted, before any session check", async () => {
    const app = apiLike([fakeStaff as ProPlugin], { staff: staffHost }, [], true);
    expect((await app.request("/api/pro/staff/providers")).status).toBe(200);
    for (const path of ["/api/staff", "/api/staff/providers", "/api/staff/me", "/api/staff/login/code"]) {
      const response = await app.request(path, { headers: { Cookie: "ohb_staff_session=x; ohb_session=y" } });
      expect(response.status).toBe(404);
      expect(response.headers.get("Deprecation")).toBeNull();
      expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route introuvable." } });
    }
  });

  test("solo: no plug-in, /api/staff is 404 and /api/pro/staff needs a session", async () => {
    const app = apiLike([], {}, [], true);
    expect((await app.request("/api/staff/providers")).status).toBe(404);
    expect((await app.request("/api/staff")).status).toBe(404);
    expect((await app.request("/api/pro/staff/providers")).status).toBe(401);
    expect(impersonationSourceOf([])).toBeNull();
  });
});
