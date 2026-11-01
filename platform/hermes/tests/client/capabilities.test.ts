import { expect, test } from "bun:test";
import { HermesClient } from "../../src/client";

test("probe errors retain normalized response evidence, including invalid JSON on HTTP 200", async () => {
  for (const status of [200, 302, 401, 403, 530]) {
    const client = new HermesClient({ transport: { kind: "direct", send: async () => new Response("private-body-secret", { status,
      headers: { "content-type": "text/html; private-secret=yes", "cf-ray": "private-ray", server: "cloudflare", location: "https://tenant.cloudflareaccess.com/login?token=private-location" } }) } });
    const error = await client.health().catch((error: unknown) => error);
    const evidence = HermesClient.directResponseEvidence(error);
    expect(evidence).toMatchObject({ status, contentType: "text/html", cloudflare: true, accessRedirect: status === 302 });
    expect(JSON.stringify(evidence)).not.toMatch(/private/);
  }
});

test("a failing /v1/skills keeps the toolsets inventory and reports skillsFailed", async () => {
  const client = new HermesClient({ transport: { kind: "direct", send: async (path: string) => {
    if (path.startsWith("/v1/skills")) {
      return Response.json({ error: { message: "Failed to enumerate skills", type: "server_error" } }, { status: 500 });
    }
    return Response.json({ object: "list", platform: "api_server", data: [
      { name: "web", label: "Web", description: "web_search", enabled: true, configured: true, tools: ["web_search"] },
    ] });
  } } });
  const inventory = await client.capabilityInventory();
  expect(inventory.toolsets?.map((toolset) => toolset.name)).toEqual(["web"]);
  expect(inventory.skills).toBeNull();
  expect(inventory.skillsFailed).toBe(true);
});
