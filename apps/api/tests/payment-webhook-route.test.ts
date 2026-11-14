import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { PLUGIN_API_VERSION, type BillingHookContext, type ProPlugin } from "@openedbot/platform-plugins";
import type { Db } from "@openedbot/platform-db";
import { assertPaymentWebhookPathFree, paymentWebhookConflicts, paymentWebhookMountOf, paymentWebhookOf } from "../src/application/pro-plugins";
import { paymentWebhookRoute } from "../src/routes/payments/payment-webhook-route";
import { isSessionlessCorePath } from "../src/interfaces/http/sessionless-paths";
import { HttpError } from "../src/interfaces/http/http-error";
import type { ApiConfig } from "../src/infrastructure/config";

// Steps 8c-8d, 11.4, 11.5: the core mounts the payment webhook at the path
// the plug-in `billing` declares (`billing.webhookPath`), outside the
// session, and only delegates; it names no provider path, bills nothing and
// checks no signature.

/** A neutral path, as a billing plug-in would declare it. */
const PAY_PATH = "/api/pay/webhook";
/** A request carrying `SESSION` stands for a signed-in one. */
const SESSION = "Bearer signed-in";

/** Never reached: the core route reads nothing, the fixture plug-in does not query. */
const db = new Proxy({}, { get() { throw new Error("the webhook touched the database"); } }) as unknown as Db;
const config = { billingPriceEur: 19 } as unknown as ApiConfig;
const ENV = { OPENEDBOT_PLUGIN_BILLING__WEBHOOK_SECRET: "plugin-side", PAY_WEBHOOK_SECRET: "core-side" };

/**
 * The order of `apps/api/src/index.ts`: core error handler, 404, the webhook
 * mount (from what the loader kept and what is installed), the session
 * check with its exemptions, then the boot check.
 */
function apiLike(loaded: readonly ProPlugin[], installed: readonly ProPlugin[] = loaded) {
  const app = new Hono();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "INTERNAL_ERROR" } }, 500));
  app.notFound((context) => context.json({ error: { code: "NOT_FOUND" } }, 404));
  const paymentWebhook = paymentWebhookMountOf(loaded, installed, ENV);
  if (paymentWebhook) app.route(paymentWebhook.path, paymentWebhookRoute(db, config, paymentWebhook.delegate));
  const isPaymentWebhookPath = (path: string) => paymentWebhook !== null && path === paymentWebhook.path;
  app.use("/api/*", async (context, next) => isSessionlessCorePath(context.req.path) || isPaymentWebhookPath(context.req.path)
    || context.req.header("authorization") === SESSION
    ? next()
    : context.json({ error: { code: "AUTH_REQUIRED" } }, 401));
  assertPaymentWebhookPathFree(paymentWebhook, app.routes);
  return app;
}

const seen: { request: Request; body: string; context?: BillingHookContext }[] = [];
const billing: ProPlugin = {
  manifest: { id: "billing", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] },
  billing: {
    webhookPath: PAY_PATH,
    webhook: async (request, context) => {
      seen.push({ request, body: await request.text(), context });
      return Response.json({ received: true, by: "billing" }, { status: 200 });
    },
  },
};
const post = (path = PAY_PATH, headers: Record<string, string> = {}) =>
  new Request(`http://api.test${path}`, { method: "POST", body: '{"id":"evt_1"}', headers });
const answer = async (response: Response) => [response.status, await response.json()];

describe("the payment webhook at the plug-in's path (step 11.5)", () => {
  test("the core names no payment path: no constant, no exemption of its own", async () => {
    const sessionless = await Bun.file(new URL("../src/interfaces/http/sessionless-paths.ts", import.meta.url)).text();
    expect(sessionless).not.toMatch(/PAYMENT_WEBHOOK_PATH|\/api\/stripe/i);
    expect(isSessionlessCorePath("/api/stripe/webhook")).toBe(false);
    expect(isSessionlessCorePath(PAY_PATH)).toBe(false);
  });

  test("index.ts mounts the declared path, exempts exactly it, and checks it after every route", async () => {
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source).toContain("const paymentWebhook = paymentWebhookMountOf(loadedPro.plugins, installedPlugins, process.env);");
    expect(source).toContain("const isPaymentWebhookPath = (path: string) => paymentWebhook !== null && path === paymentWebhook.path;");
    expect(source).toContain("if (paymentWebhook) app.route(paymentWebhook.path, paymentWebhookRoute(db, config, paymentWebhook.delegate));");
    expect(source).toContain("if (isSessionlessCorePath(path) || isProPublicPath(path) || isPaymentWebhookPath(path)) return next();");
    const mount = source.indexOf("if (paymentWebhook) app.route(");
    const session = source.indexOf("isPaymentWebhookPath(path)) return next();");
    const check = source.indexOf("assertPaymentWebhookPathFree(paymentWebhook, app.routes);");
    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(session);
    expect(check).toBeGreaterThan(source.lastIndexOf("app.route("));
    expect(check).toBeLessThan(source.indexOf("Bun.serve"));
  });

  test("solo: nothing is mounted, the path reads like any unknown path", async () => {
    expect(paymentWebhookMountOf([], [])).toBeNull();
    const solo = apiLike([]);
    for (const path of [PAY_PATH, "/api/stripe/webhook"]) {
      expect(await answer(await solo.fetch(post(path)))).toEqual(await answer(await solo.fetch(post("/api/unknown/route"))));
    }
    expect(await answer(await solo.fetch(post()))).toEqual([401, { error: { code: "AUTH_REQUIRED" } }]);
    expect(solo.routes.some((route) => route.path === PAY_PATH)).toBe(false);
  });

  test("billing loaded but refused by the role guard: 503 PAYMENT_WEBHOOK_UNAVAILABLE at its path, without a session", async () => {
    seen.length = 0;
    expect(paymentWebhookMountOf([billing], [])).toEqual({ path: PAY_PATH, delegate: null });
    const refused = apiLike([billing], []);
    for (const headers of [{} as Record<string, string>, { "Provider-Signature": "t=1,v1=00" }]) {
      expect(await answer(await refused.fetch(post(PAY_PATH, headers)))).toEqual([503, { error: { code: "PAYMENT_WEBHOOK_UNAVAILABLE" } }]);
    }
    expect(seen).toHaveLength(0);
  });

  test("installed: it receives the raw request at its path, its response returned as is", async () => {
    seen.length = 0;
    const response = await apiLike([billing]).fetch(post(PAY_PATH, { "Provider-Signature": "t=1,v1=abc" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, by: "billing" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe('{"id":"evt_1"}');
    expect(seen[0]!.request.headers.get("Provider-Signature")).toBe("t=1,v1=abc");
    // Only its own OPENEDBOT_PLUGIN_BILLING__* variables, never the core's, nor an undeclared deployment name.
    expect(seen[0]!.context?.config).toEqual({ WEBHOOK_SECRET: "plugin-side" });
    expect(seen[0]!.context?.env).toBeUndefined();
    // Step 8d: the core lends its database and resolved config, nothing else.
    const host = seen[0]!.context?.host as { db: unknown; config: ApiConfig };
    expect(Object.keys(host).sort()).toEqual(["config", "db"]);
    expect(host.db).toBe(db);
    expect(host.config).toBe(config);
  });

  test("only POST, and only the exact path: other methods are the core 404, a sub-path needs a session", async () => {
    seen.length = 0;
    for (const loaded of [[billing], [billing, { ...billing, manifest: { ...billing.manifest, id: "other" } }]] as ProPlugin[][]) {
      const app = apiLike(loaded, [billing]);
      for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
        expect([method, (await app.request(PAY_PATH, { method })).status]).toEqual([method, 404]);
      }
      expect(await answer(await app.fetch(post(`${PAY_PATH}/other`)))).toEqual([401, { error: { code: "AUTH_REQUIRED" } }]);
      expect(await answer(await app.fetch(post("/api/stripe/webhook")))).toEqual([401, { error: { code: "AUTH_REQUIRED" } }]);
    }
    expect(seen).toHaveLength(0);
  });

  test("a declared deployment variable reaches the webhook as context.env", async () => {
    seen.length = 0;
    const declaring: ProPlugin = { ...billing, manifest: { ...billing.manifest, env: [{ name: "PAY_WEBHOOK_SECRET" }] } };
    await apiLike([declaring]).fetch(post());
    expect(seen[0]!.context?.env).toEqual({ PAY_WEBHOOK_SECRET: "core-side" });
  });

  test("a throwing plug-in is the core's 500, not a crash", async () => {
    const broken: ProPlugin = { ...billing, billing: { webhookPath: PAY_PATH, webhook: async () => { throw new Error("boom"); } } };
    expect(await answer(await apiLike([broken]).fetch(post()))).toEqual([500, { error: { code: "INTERNAL_ERROR" } }]);
  });

  test("billing hooks from another plug-in are ignored by the host", () => {
    const other = { ...billing, manifest: { ...billing.manifest, id: "staff" } };
    expect(paymentWebhookOf([other])).toBeNull();
    expect(paymentWebhookMountOf([other], [other])).toBeNull();
  });

  test("the core route holds no payment logic: no body read, no signature, no provider call", async () => {
    const source = await Bun.file(new URL("../src/routes/payments/payment-webhook-route.ts", import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const forbidden of [/signature/i, /stripe/i, /createHmac|timingSafeEqual|node:crypto/, /\.text\(\)|\.json\(\)|arrayBuffer|boundedTextBody/, /fetch\(/]) {
      expect([forbidden.source, forbidden.test(code)]).toEqual([forbidden.source, false]);
    }
  });
});

describe("solo: the webhook path is not served (step 11.5)", () => {
  // Without the plug-in `billing`, no webhook is mounted and no path is
  // exempted: the provider's path and a neutral one read like any unknown
  // `/api` path, 401 before the session, 404 behind it. Never a 503, never
  // the delegate.
  const methods = ["POST", "GET", "PUT", "PATCH", "DELETE"] as const;
  const call = (path: string, method: string, headers: Record<string, string> = {}) =>
    new Request(`http://api.test${path}`, { method, headers, ...(method === "GET" ? {} : { body: '{"id":"evt_1"}' }) });

  test("without a session: 401 AUTH_REQUIRED on every method", async () => {
    const solo = apiLike([]);
    for (const path of [PAY_PATH, "/api/stripe/webhook"]) {
      for (const method of methods) {
        expect(await answer(await solo.fetch(call(path, method)))).toEqual([401, { error: { code: "AUTH_REQUIRED" } }]);
      }
    }
  });

  test("with a session: 404 NOT_FOUND on every method, the plug-in never reached", async () => {
    seen.length = 0;
    const solo = apiLike([]);
    for (const path of [PAY_PATH, "/api/stripe/webhook"]) {
      for (const method of methods) {
        expect(await answer(await solo.fetch(call(path, method, { authorization: SESSION })))).toEqual([404, { error: { code: "NOT_FOUND" } }]);
      }
    }
    expect(seen).toHaveLength(0);
  });

  test("a payment secret alone mounts nothing, and index.ts mounts only what the mount names", async () => {
    expect(paymentWebhookMountOf([], [], { STRIPE_WEBHOOK_SECRET: "x" })).toBeNull();
    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source).toContain("if (paymentWebhook) app.route(");
    expect(source).toContain("paymentWebhook !== null && path === paymentWebhook.path");
  });
});

describe("the boot check: no core route answers the webhook path (step 11.5)", () => {
  const own = { method: "POST", path: PAY_PATH };

  test("its own POST, middlewares and unrelated routes are no conflict", () => {
    expect(paymentWebhookConflicts(PAY_PATH, [
      { method: "ALL", path: "/api/*" }, { method: "ALL", path: "*" }, own,
      { method: "GET", path: "/api/pay" }, { method: "POST", path: "/api/payments/webhook" }, { method: "GET", path: "/api/inbox/:id" },
    ])).toEqual([]);
    expect(() => assertPaymentWebhookPathFree(null, [{ method: "POST", path: PAY_PATH }, { method: "POST", path: PAY_PATH }])).not.toThrow();
  });

  test("a second POST, another method, a sub-path or a parameter over it is a conflict", () => {
    expect(paymentWebhookConflicts(PAY_PATH, [own, { method: "POST", path: PAY_PATH }])).toEqual([`POST ${PAY_PATH}`]);
    expect(paymentWebhookConflicts(PAY_PATH, [{ method: "GET", path: PAY_PATH }, own])).toEqual([`GET ${PAY_PATH}`]);
    expect(paymentWebhookConflicts(PAY_PATH, [own, { method: "POST", path: `${PAY_PATH}/retry` }])).toEqual([`POST ${PAY_PATH}/retry`]);
    expect(paymentWebhookConflicts(PAY_PATH, [own, { method: "POST", path: "/api/pay/:id" }])).toEqual(["POST /api/pay/:id"]);
    expect(paymentWebhookConflicts(PAY_PATH, [own, { method: "GET", path: "/api/:root/webhook" }])).toEqual(["GET /api/:root/webhook"]);
  });

  test("the API refuses to start on a conflict", () => {
    const mount = paymentWebhookMountOf([billing], [billing])!;
    expect(() => assertPaymentWebhookPathFree(mount, [own, { method: "GET", path: PAY_PATH }]))
      .toThrow(`billing.webhookPath ${PAY_PATH} is also served by the core: GET ${PAY_PATH}.`);
    const app = new Hono();
    app.route(PAY_PATH, paymentWebhookRoute(db, config, mount.delegate));
    app.post("/api/pay/:id", (context) => context.text("core"));
    expect(() => assertPaymentWebhookPathFree(mount, app.routes)).toThrow("is also served by the core: POST /api/pay/:id.");
  });
});
