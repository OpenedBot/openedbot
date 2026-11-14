import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { API_SECURITY_HEADERS, apiSecurityHeaders } from "../src/interfaces/http/security-headers";

function app(): Hono {
  const routes = new Hono();
  routes.use("/api/*", apiSecurityHeaders());
  routes.get("/api/json", (context) => context.json({ ok: true }));
  routes.get("/api/sandboxed", (context) => {
    context.header("Content-Security-Policy", "sandbox");
    context.header("Cache-Control", "private, max-age=60");
    return context.body("<p>doc</p>", 200, { "Content-Type": "text/html" });
  });
  // A relayed fetch response: its headers are immutable.
  routes.get("/api/relayed", async () => {
    const upstream = await fetch("data:application/json,%7B%7D");
    return upstream;
  });
  routes.get("/api/denied", (context) => context.json({ error: { code: "AUTH_REQUIRED" } }, 401));
  routes.get("/outside", (context) => context.text("not api"));
  return routes;
}

describe("apiSecurityHeaders", () => {
  test("puts every header on a plain API answer, refusals included", async () => {
    for (const path of ["/api/json", "/api/denied"]) {
      const response = await app().request(path);
      for (const [name, value] of API_SECURITY_HEADERS) expect(response.headers.get(name)).toBe(value);
    }
  });

  test("never overrides what a route decided", async () => {
    const response = await app().request("/api/sandboxed");
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=60");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("<p>doc</p>");
  });

  test("copies a response whose headers are immutable instead of throwing", async () => {
    const response = await app().request("/api/relayed");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-site");
    expect(await response.text()).toBe("{}");
  });

  test("leaves routes outside /api alone", async () => {
    const response = await app().request("/outside");
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });
});
