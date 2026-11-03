/**
 * Compatibility aliases (open-core step 11.2): a plug-in maps the names it
 * published before onto the current ones; the core carries none of its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { compatAliasesOf } from "@openedbot/platform-plugins";
import { compatHeaderNames, compatPathRedirects, installCompatAliases, requestHeader, requestQuery, shadowsCoreRoute } from "../src/application/compat-aliases";

afterEach(() => installCompatAliases({}));

function probe() {
  const app = new Hono();
  app.get("/probe", (c) => c.json({ header: requestHeader(c, "X-OpenedBot-New") ?? null, query: requestQuery(c, "newId") ?? null }));
  return app;
}

describe("compat aliases", () => {
  test("solo: no plug-in alias, an old header or query is simply unknown", async () => {
    expect(compatAliasesOf([])).toEqual({ headers: [], queries: [], paths: [], entitlements: [] });
    expect(compatHeaderNames()).toEqual(["X-OHB-Organization", "X-OHB-Fleet", "X-OHB-Support-Token"]);
    const response = await probe().request("/probe?oldId=1", { headers: { "X-OpenedBot-Old": "a" } });
    expect(await response.json()).toEqual({ header: null, query: null });
  });

  test("solo: the names published before 11.2 mean nothing to the core", async () => {
    const app = new Hono();
    app.get("/fleet", (c) => c.json({ header: requestHeader(c, "X-OpenedBot-Fleet") ?? null, query: requestQuery(c, "fleetId") ?? null }));
    const response = await app.request("/fleet?agencyId=1", { headers: { "X-OHB-Agency": "a" } });
    expect(await response.json()).toEqual({ header: null, query: null });
  });

  test("installed: the old header and query answer for the new ones, the new ones win", async () => {
    installCompatAliases({ headers: [{ from: "X-OpenedBot-Old", to: "X-OpenedBot-New" }], queries: [{ from: "oldId", to: "newId" }] });
    expect(compatHeaderNames()).toEqual(["X-OHB-Organization", "X-OHB-Fleet", "X-OHB-Support-Token", "X-OpenedBot-Old"]);
    const old = await probe().request("/probe?oldId=1", { headers: { "x-openedbot-old": "a" } });
    expect(await old.json()).toEqual({ header: "a", query: "1" });
    const both = await probe().request("/probe?oldId=1&newId=2", { headers: { "X-OpenedBot-Old": "a", "X-OpenedBot-New": "b" } });
    expect(await both.json()).toEqual({ header: "b", query: "2" });
  });

  test("the core's X-OHB-* request headers still answer for one release, the new name wins", async () => {
    installCompatAliases({});
    const app = new Hono();
    app.get("/org", (c) => c.json({ organization: requestHeader(c, "X-OpenedBot-Organization") ?? null, support: requestHeader(c, "X-OpenedBot-Support-Token") ?? null }));
    const old = await app.request("/org", { headers: { "X-OHB-Organization": "o1", "x-ohb-support-token": "t1" } });
    expect(await old.json()).toEqual({ organization: "o1", support: "t1" });
    const both = await app.request("/org", { headers: { "X-OHB-Organization": "o1", "X-OpenedBot-Organization": "o2" } });
    expect(await both.json()).toEqual({ organization: "o2", support: null });
    expect(compatHeaderNames()).toEqual(["X-OHB-Organization", "X-OHB-Fleet", "X-OHB-Support-Token"]);
  });

  test("an old path answers 308 to the new one, rest and query kept, never cached", async () => {
    const app = new Hono();
    app.use("/api/*", compatPathRedirects([{ from: "/api/old", to: "/api/pro/new" }], () => app.routes));
    app.get("/api/olden", (c) => c.text("core"));
    for (const [from, to] of [["/api/old", "/api/pro/new"], ["/api/old/a/b?x=1&y=2", "/api/pro/new/a/b?x=1&y=2"]] as const) {
      const response = await app.request(from, { method: "POST" });
      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe(to);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(await (await app.request("/api/olden")).text()).toBe("core");
  });

  test("an exact alias redirects its one path, POST body kept, and nothing below it", async () => {
    const app = new Hono();
    app.use("/api/*", compatPathRedirects([{ from: "/api/auth/old-claim", to: "/api/auth/new-claim", exact: true }], () => app.routes));
    app.post("/api/auth/new-claim", (c) => c.text("claimed"));
    const response = await app.request("/api/auth/old-claim?x=1", { method: "POST", body: "code=c" });
    expect([response.status, response.headers.get("Location")]).toEqual([308, "/api/auth/new-claim?x=1"]);
    expect((await app.request("/api/auth/old-claim/deeper", { method: "POST" })).status).toBe(404);
  });

  test("an alias over a core route is dropped and reported once", async () => {
    const warned: unknown[] = [];
    const app = new Hono();
    app.use("/api/*", compatPathRedirects([{ from: "/api/core", to: "/api/pro/x" }], () => app.routes, (event) => warned.push(event)));
    app.get("/api/core/:id", (c) => c.text("core"));
    expect(await (await app.request("/api/core/1")).text()).toBe("core");
    expect(await (await app.request("/api/core/2")).text()).toBe("core");
    expect(warned).toEqual([{ from: "/api/core", reason: "shadows a core route" }]);
    expect(shadowsCoreRoute("/api/a", [{ method: "ALL", path: "/api/a/*" }])).toBe(false);
    expect(shadowsCoreRoute("/api/a/b", [{ method: "GET", path: "/api/a/:id" }])).toBe(true);
  });

  test("the core source holds no old name: every alias is a plug-in's", () => {
    const root = join(import.meta.dir, "../../..");
    const roots = ["apps/api/src", "apps/worker/src", "apps/console/src", "modules", "platform", "browser", "contracts"].map((dir) => join(root, dir));
    const forbidden = [/X-OHB-Agency/i, /["'`]\/api\/agency\b/, /["'`]\/api\/invite\/agency\b/, /["'`]\/invite\/agency\//, /["'`]agency\.(?:workspaces|billing)["'`]/, /\/api\/organization\/agency-grants/,
      // the same paths written as a regular expression (`\/api\/invite\/(agency|member)\/`)
      /\\\/api\\\/(?:invite\\\/)?\(?(?:[a-z]+\|)*agency\b/];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|tsx|html)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = readFileSync(path, "utf8");
          for (const pattern of forbidden) if (pattern.test(text)) hits.push(`${path.slice(root.length + 1)} ${pattern}`);
        }
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });
});
