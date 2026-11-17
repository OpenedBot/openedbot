import { expect, test } from "bun:test";
import { createFakeHost } from "./host-operator";

// Refused calls are recorded too, so adding an unannounced route cannot hide
// behind the integration fixture's successful profile lifecycle.
test("profile-only host exposes lifecycle and refuses every other host feature", async () => {
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const host = createFakeHost({ profileManagementOnly: true, requests });
  const call = (method: string, tail: string, body?: unknown) => host.handleHostRoute(new Request(`http://fixture.invalid/hermes-setup${tail}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }), `/hermes-setup${tail}`);
  expect(await (await call("GET", "/capabilities"))!.json()).toEqual({ features: ["profile_management"] });
  for (const [method, path] of [
    ["GET", "/toolsets"], ["GET", "/usage"], ["GET", "/skills"], ["GET", "/mcp/servers"],
    ["POST", "/providers/openai/credentials"], ["POST", "/gateway/restart"],
    ["POST", "/profiles/demo/model"], ["GET", "/profiles/demo/memory"],
    ["PUT", "/profiles/demo/approval-policy"], ["POST", "/profiles/demo/bundled-skills"],
    ["POST", "/profiles/demo/toolsets/memory"], ["GET", "/sessions-inventory"],
  ]) expect((await call(method!, path!))!.status).toBe(404);
  expect((await call("POST", "/profiles", { name: "demo", provider: "fake", model: "fake/model" }))!.status).toBe(400);
  expect((await call("POST", "/profiles", { name: "demo" }))!.status).toBe(201);
  expect(host.hasProfile("demo")).toBe(true);
  expect(await (await call("GET", "/profiles"))!.json()).toMatchObject({ multiplex: true, profiles: [{ name: "demo", model: { provider: null, default: null }, toolsets: [], skills: [], mcpServers: [] }] });
  // A real profile must not unlock its unrelated administration routes.
  expect((await call("POST", "/profiles/demo/model", { provider: "fake", model: "fake/model" }))!.status).toBe(404);
  expect((await call("DELETE", "/profiles/demo"))!.status).toBe(204);
  expect(host.hasProfile("demo")).toBe(false);
  expect(requests).toHaveLength(18);
  expect(requests.filter((request) => request.status === 404)).toHaveLength(13);
});
