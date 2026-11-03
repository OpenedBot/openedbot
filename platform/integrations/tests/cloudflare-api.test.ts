import { describe, expect, test } from "bun:test";
import { CloudflareApiError, cloudflareTunnelCname, createCloudflareApiClient } from "../src/cloudflare-api";

type Call = { method: string; url: string; body: unknown; authorization: string | null };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null, authorization: headers.get("authorization") };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("OHB-75 Cloudflare API client", () => {
  test("sends the bearer, parses envelopes and never leaks the token in an error", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url.endsWith("/user/tokens/verify")) return Response.json({ success: true, result: { id: "tok", status: "active" } });
      if (call.url.includes("/zones?")) return Response.json({ success: true, result: [{ id: "zone-1", name: "example.com", account: { id: "acct-1" } }] });
      if (call.url.endsWith("/cfd_tunnel") && call.method === "POST") return Response.json({ success: true, result: { id: "tun-1", name: "ohb-hermes-x", status: "inactive" } });
      if (call.url.endsWith("/token")) return Response.json({ success: true, result: "x".repeat(64) });
      if (call.url.endsWith("/service_tokens")) return Response.json({ success: true, result: { id: "st-1", name: "n", client_id: "cid", client_secret: "csecret" } });
      return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    });
    const client = createCloudflareApiClient("secret-api-token", { fetch: fetchImpl });
    expect(await client.verifyToken()).toEqual({ id: "tok", status: "active" });
    expect(await client.listZones("example.com")).toEqual([{ id: "zone-1", name: "example.com", accountId: "acct-1" }]);
    expect((await client.createTunnel("acct-1", "ohb-hermes-x")).id).toBe("tun-1");
    expect(await client.readTunnelToken("acct-1", "tun-1")).toHaveLength(64);
    expect((await client.createServiceToken("acct-1", "n")).clientSecret).toBe("csecret");
    expect(calls.every((call) => call.authorization === "Bearer secret-api-token")).toBe(true);
    expect(calls.every((call) => !call.url.includes("secret-api-token"))).toBe(true);
    let caught: unknown;
    try { await client.deleteAccessApp("acct-1", "app-1"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CloudflareApiError);
    expect((caught as CloudflareApiError).code).toBe("CLOUDFLARE_TOKEN_REJECTED");
    expect(String(caught)).not.toContain("secret-api-token");
    expect(String(caught)).not.toContain("Authentication error");
  });

  test("maps 404 to not found, duplicate names to conflict, and treats an absent resource on delete as done", async () => {
    const { fetchImpl } = fakeFetch((call) => {
      if (call.method === "DELETE") return Response.json({ success: false, errors: [] }, { status: 404 });
      if (call.method === "POST") return Response.json({ success: false, errors: [{ message: "tunnel with name already exists" }] }, { status: 400 });
      return Response.json({ success: true, result: [] });
    });
    const client = createCloudflareApiClient("t".repeat(40), { fetch: fetchImpl });
    await client.deleteTunnel("acct", "tun");
    await client.deleteDnsRecord("zone", "rec");
    let caught: unknown;
    try { await client.createTunnel("acct", "dup"); } catch (error) { caught = error; }
    expect((caught as CloudflareApiError).code).toBe("CLOUDFLARE_CONFLICT");
    expect(await client.findTunnel("acct", "missing")).toBeNull();
  });

  test("upsert reuses an existing CNAME and the ingress points the hostname at the origin", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url.includes("/dns_records?")) return Response.json({ success: true, result: [{ id: "rec-1", name: "hermes.example.com", type: "CNAME", content: "old" }] });
      if (call.method === "PUT") return Response.json({ success: true, result: call.url.includes("/dns_records/") ? { id: "rec-1", name: "hermes.example.com", type: "CNAME", content: call.body && typeof call.body === "object" ? (call.body as { content: string }).content : "" } : {} });
      return Response.json({ success: true, result: {} });
    });
    const client = createCloudflareApiClient("t".repeat(40), { fetch: fetchImpl });
    const record = await client.upsertTunnelCname("zone", "hermes.example.com", "tun-1");
    expect(record.content).toBe(cloudflareTunnelCname("tun-1"));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    await client.putTunnelIngress("acct", "tun-1", "hermes.example.com", "http://127.0.0.1:8642");
    const ingress = calls.find((call) => call.url.endsWith("/configurations"))!;
    expect(ingress.body).toEqual({ config: { ingress: [{ hostname: "hermes.example.com", service: "http://127.0.0.1:8642" }, { service: "http_status:404" }] } });
  });
});
