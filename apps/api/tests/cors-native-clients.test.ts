import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HttpError } from "../src/interfaces/http/http-error";
import { CLIENT_HEADER, corsMiddleware } from "../src/interfaces/http/cors";
import { responseCompression } from "../src/interfaces/http/compression";
import { CLIENT_UPDATE_REQUIRED, clientVersionGate, desktopClientVersion } from "../src/interfaces/http/client-version";
import { parseSemVer } from "@openedbot/platform-config/native-clients";

const WEB = "https://openedbot.app";
const NATIVE = "tauri://localhost";

function app(minDesktopVersion = parseSemVer("1.2.0")): Hono {
  const routes = new Hono();
  routes.use("*", corsMiddleware({ browserOrigins: [WEB], nativeOrigins: [NATIVE, "http://tauri.localhost"] }));
  routes.use("/api/*", clientVersionGate(minDesktopVersion));
  routes.get("/api/health", (context) => context.json({ ok: true }));
  routes.get("/api/threads", (context) => context.json({ ok: true }));
  // Like `/api/events`: a raw `Response`, outside the Hono context.
  routes.get("/api/events", () => new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  routes.onError((error, context) => {
    if (!(error instanceof HttpError)) throw error;
    return context.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status as 400);
  });
  return routes;
}

const get = (routes: Hono, headers: Record<string, string>, path = "/api/threads", method = "GET") =>
  routes.request(path, { method, headers });

describe("CORS de l'API", () => {
  test("une origine web garde ses cookies", async () => {
    const response = await get(app(), { Origin: WEB });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("X-Request-Id");
  });

  test("une origine de l'app de bureau passe, mais jamais avec les cookies", async () => {
    for (const origin of [NATIVE, "http://tauri.localhost"]) {
      const response = await get(app(), { Origin: origin });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(response.headers.get("Access-Control-Expose-Headers")).toBe("X-Request-Id");
      expect(response.headers.get("Vary")).toBe("Origin");
    }
  });

  test("un flux rendu en Response brute (SSE) porte aussi les en-têtes CORS", async () => {
    const native = await get(app(), { Origin: NATIVE }, "/api/events");
    expect(native.headers.get("Content-Type")).toBe("text/event-stream");
    expect(native.headers.get("Access-Control-Allow-Origin")).toBe(NATIVE);
    expect(native.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(native.headers.get("Access-Control-Expose-Headers")).toBe("X-Request-Id");
    const web = await get(app(), { Origin: WEB }, "/api/events");
    expect(web.headers.get("Access-Control-Allow-Origin")).toBe(WEB);
    expect(web.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const unknown = await get(app(), { Origin: "https://evil.example" }, "/api/events");
    expect(unknown.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("Vary garde Accept-Encoding posé par la compression", async () => {
    const routes = new Hono();
    routes.use("*", corsMiddleware({ browserOrigins: [WEB], nativeOrigins: [NATIVE] }));
    routes.use("/api/*", responseCompression());
    routes.get("/api/legal", (context) => context.json({ text: "x".repeat(8192) }));
    for (const origin of [WEB, NATIVE]) {
      // happy-dom strips `Accept-Encoding` from a `Request` (forbidden header): it is set back (`compression.test.ts`).
      const request = new Request("http://api.test/api/legal", { headers: { Origin: origin } });
      const headers = new Headers(request.headers);
      headers.set("Accept-Encoding", "gzip");
      Object.defineProperty(request, "headers", { value: headers, configurable: true });
      const response = await routes.request(request);
      expect(response.headers.get("Content-Encoding")).toBe("gzip");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      const vary = (response.headers.get("Vary") ?? "").split(",").map((value) => value.trim().toLowerCase());
      expect(vary).toContain("accept-encoding");
      expect(vary.filter((value) => value === "origin")).toHaveLength(1);
    }
  });

  test("une origine inconnue ou null ne reçoit aucun en-tête CORS", async () => {
    for (const origin of ["null", "https://evil.example", "tauri://evil"]) {
      const response = await get(app(), { Origin: origin });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });

  test("le préflight autorise l'en-tête client et l'espace, et se met en cache", async () => {
    const routes = app(parseSemVer("1.2.0"));
    const first = await get(routes, { Origin: NATIVE }, "/api/threads", "OPTIONS");
    expect(first.status).toBe(204);
    const allowed = first.headers.get("Access-Control-Allow-Headers")!.split(", ");
    expect(allowed).toContain(CLIENT_HEADER);
    expect(allowed).toContain("X-OpenedBot-Organization");
    expect(allowed.some((name) => /fleet/i.test(name))).toBe(false);
    expect(first.headers.get("Access-Control-Max-Age")).toBe("600");
    const stranger = await get(routes, { Origin: "https://evil.example" }, "/api/threads", "OPTIONS");
    expect(stranger.headers.get("Access-Control-Max-Age")).toBeNull();
  });
});

describe("garde de version de l'app de bureau", () => {
  test("une app plus vieille que le minimum reçoit 426, avec le CORS pour qu'elle puisse le lire", async () => {
    const response = await get(app(), { Origin: NATIVE, [CLIENT_HEADER]: "desktop/1.1.9" });
    expect(response.status).toBe(426);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(NATIVE);
    expect(await response.json()).toMatchObject({ error: { code: CLIENT_UPDATE_REQUIRED, details: { minVersion: "1.2.0", version: "1.1.9" } } });
  });

  test("le minimum lui-même, une version plus récente, un navigateur ou un en-tête illisible passent", async () => {
    for (const client of ["desktop/1.2.0", "desktop/1.10.0", "desktop/2.0.0", "web/0.0.1", "desktop/1.1", "desktop/1.1.9-beta", ""]) {
      const headers: Record<string, string> = client ? { [CLIENT_HEADER]: client } : {};
      expect((await get(app(), headers)).status).toBe(200);
    }
  });

  test("le bilan de santé reste ouvert, et sans minimum rien n'est refusé", async () => {
    expect((await get(app(), { [CLIENT_HEADER]: "desktop/0.0.1" }, "/api/health")).status).toBe(200);
    expect((await get(app(null), { [CLIENT_HEADER]: "desktop/0.0.1" })).status).toBe(200);
  });

  test("desktopClientVersion ne lit que desktop/X.Y.Z", () => {
    expect(desktopClientVersion(" desktop/3.4.5 ")).toEqual([3, 4, 5]);
    expect(desktopClientVersion("desktop/3.4")).toBeNull();
    expect(desktopClientVersion("Desktop/3.4.5")).toBeNull();
    expect(desktopClientVersion(undefined)).toBeNull();
  });
});
