import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { invalidPluginReason, PLUGIN_API_VERSION, type ProPlugin } from "@openedbot/platform-plugins";
import { assertPublicEndpointPathsFree, pluginPublicEndpoints, publicEndpointPaths } from "../src/application/public-endpoints";

const path = "/api/callbacks/fixture";
function plugin(build: () => (request: Request) => Response | Promise<Response> = () => () => new Response("ok")): ProPlugin {
  return { manifest: { id: "fixture", version: "1.0.0", pluginApi: PLUGIN_API_VERSION, entitlements: [] }, publicEndpoints: [{ method: "POST", path, build }] };
}

describe("exact public endpoints owned by plug-ins", () => {
  test("solo registers and exempts nothing", async () => {
    const app = pluginPublicEndpoints([], [], () => ({}));
    expect(publicEndpointPaths([]).size).toBe(0);
    expect((await app.request(path, { method: "POST" })).status).toBe(404);
  });
  test("passes raw bytes and headers, returns the handler response unchanged", async () => {
    let received = "";
    const response = new Response("accepted", { status: 202, headers: { "X-Receipt": "one" } });
    const fixture = plugin(() => async (request) => {
      received = (await request.text()) + ":" + request.headers.get("Provider-Signature");
      return response;
    });
    const app = pluginPublicEndpoints([fixture], [fixture], () => ({}));
    const actual = await app.request(path, { method: "POST", body: "{ \"id\": 1 }\n", headers: { "Provider-Signature": "signature" } });
    expect(received).toBe('{ "id": 1 }\n:signature');
    expect(actual.status).toBe(202);
    expect(actual.headers.get("X-Receipt")).toBe("one");
    expect(await actual.text()).toBe("accepted");
    expect((await app.request(path)).status).toBe(404);
    expect((await app.request(path + "/child", { method: "POST" })).status).toBe(404);
  });
  test("a declaration refused by the DB role guard stays explicitly unavailable", async () => {
    const fixture = plugin(() => { throw new Error("must not build a refused plug-in"); });
    const app = pluginPublicEndpoints([fixture], [], () => ({}));
    const response = await app.request(path, { method: "POST" });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("PLUGIN_ENDPOINT_UNAVAILABLE");
  });
  test("invalid handler configuration fails startup instead of dropping the endpoint", () => {
    const fixture = plugin(() => { throw new Error("invalid provider configuration"); });
    expect(() => pluginPublicEndpoints([fixture], [fixture], () => ({}))).toThrow("invalid provider configuration");
  });
  test("rejects duplicates and conflicts with literal or parameterized core routes", () => {
    const fixture = plugin();
    expect(() => pluginPublicEndpoints([fixture, fixture], [fixture], () => ({}))).toThrow("Duplicate");
    for (const corePath of [path, "/api/callbacks/:id", path + "/child"]) {
      const app = new Hono();
      app.route("/", pluginPublicEndpoints([fixture], [fixture], () => ({})));
      app.get(corePath, (c) => c.text("core"));
      expect(() => assertPublicEndpointPathsFree([fixture], app.routes)).toThrow("shadows");
    }
    const app = pluginPublicEndpoints([fixture], [fixture], () => ({}));
    expect(() => assertPublicEndpointPathsFree([fixture], app.routes)).not.toThrow();
  });
  test("loader rejects reserved paths, malformed methods and the retired billing transport", () => {
    for (const invalid of ["/api/auth/callback", "/api/pro/fixture", "/api/hooks/callback", "/api/runtime-links/ws", "/api/support/callback", "/api/waitlist/callback", "/api/x/:id", "/api/x/y?z=1"]) {
      const fixture = plugin();
      expect(invalidPluginReason({ ...fixture, publicEndpoints: [{ ...fixture.publicEndpoints![0], path: invalid }] })).not.toBeNull();
    }
    expect(invalidPluginReason({ ...plugin(), manifest: { ...plugin().manifest, id: "billing" }, billing: { webhookPath: path, webhook: () => new Response() } })).toBe("billing HTTP endpoints must use publicEndpoints");
  });
});
