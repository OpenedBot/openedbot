/**
 * Path aliases: a plug-in maps the old paths it published onto the current
 * ones; the core carries none of its own.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { compatPathAliasesOf } from "@openedbot/platform-plugins";
import { compatPathRedirects, shadowsCoreRoute } from "../src/application/compat-aliases";

describe("compat path aliases", () => {
  test("solo: no plug-in alias, an old path is simply unknown", async () => {
    expect(compatPathAliasesOf([])).toEqual([]);
    const app = new Hono();
    app.use("/api/*", compatPathRedirects([], () => app.routes));
    expect((await app.request("/api/old")).status).toBe(404);
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
    app.use("/api/*", compatPathRedirects([{ from: "/api/old-claim", to: "/api/new-claim", exact: true }], () => app.routes));
    app.post("/api/new-claim", (c) => c.text("claimed"));
    const response = await app.request("/api/old-claim?x=1", { method: "POST", body: "code=c" });
    expect([response.status, response.headers.get("Location")]).toEqual([308, "/api/new-claim?x=1"]);
    expect((await app.request("/api/old-claim/deeper", { method: "POST" })).status).toBe(404);
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

});
