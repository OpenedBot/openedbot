import { describe, expect, test } from "bun:test";
import { CloudflareApiError, type CloudflareApiClient } from "@openedbot/platform-integrations/cloudflare-api";
import { deprovisionDirectExposure, provisionDirectExposure } from "../src/application/direct-exposure-provisioning";

/** A Cloudflare account in memory: what exists, what was called, and one step that can be made to fail. */
function fakeCloudflare(options: { existingTunnel?: boolean; failAt?: keyof CloudflareApiClient } = {}) {
  const log: string[] = [];
  const state = { tunnels: options.existingTunnel ? ["tun-existing"] : [] as string[], records: [] as string[], apps: [] as string[], tokens: [] as string[] };
  const fail = (name: keyof CloudflareApiClient) => { if (options.failAt === name) throw new CloudflareApiError("CLOUDFLARE_UNAVAILABLE", 502, "boom"); };
  const client: CloudflareApiClient = {
    verifyToken: async () => ({ id: "t", status: "active" }),
    listZones: async () => [],
    findTunnel: async (_a, name) => { log.push(`findTunnel:${name}`); return state.tunnels[0] ? { id: state.tunnels[0], name, status: "inactive", deletedAt: null } : null; },
    createTunnel: async (_a, name) => { fail("createTunnel"); log.push(`createTunnel:${name}`); state.tunnels.push("tun-new"); return { id: "tun-new", name, status: "inactive", deletedAt: null }; },
    readTunnel: async (_a, id) => ({ id, name: "x", status: "healthy", deletedAt: null }),
    putTunnelIngress: async (_a, id, hostname, service) => { fail("putTunnelIngress"); log.push(`ingress:${id}:${hostname}:${service}`); },
    readTunnelToken: async (_a, id) => { fail("readTunnelToken"); log.push(`token:${id}`); return "install-token-".padEnd(48, "x"); },
    deleteTunnel: async (_a, id) => { log.push(`deleteTunnel:${id}`); state.tunnels = state.tunnels.filter((t) => t !== id); },
    findDnsRecord: async (_z, name) => { log.push(`findDns:${name}`); return state.records[0] ? { id: state.records[0], name, type: "CNAME", content: "" } : null; },
    upsertTunnelCname: async (_z, name, tunnelId) => { fail("upsertTunnelCname"); log.push(`cname:${name}:${tunnelId}`); state.records.push("rec-1"); return { id: "rec-1", name, type: "CNAME", content: `${tunnelId}.cfargotunnel.com` }; },
    deleteDnsRecord: async (_z, id) => { log.push(`deleteDns:${id}`); state.records = state.records.filter((r) => r !== id); },
    findAccessApp: async (_a, domain) => { log.push(`findApp:${domain}`); return state.apps[0] ? { id: state.apps[0], domain, name: "x" } : null; },
    createAccessApp: async (_a, domain, name) => { fail("createAccessApp"); log.push(`createApp:${domain}`); state.apps.push("app-1"); return { id: "app-1", domain, name }; },
    deleteAccessApp: async (_a, id) => { log.push(`deleteApp:${id}`); state.apps = state.apps.filter((a) => a !== id); },
    createServiceToken: async (_a, name) => { fail("createServiceToken"); log.push(`createToken:${name}`); state.tokens.push("st-1"); return { id: "st-1", name, clientId: "cid", clientSecret: "csecret" }; },
    deleteServiceToken: async (_a, id) => { log.push(`deleteToken:${id}`); state.tokens = state.tokens.filter((t) => t !== id); },
    createServiceAuthPolicy: async (_a, appId, tokenId) => { fail("createServiceAuthPolicy"); log.push(`policy:${appId}:${tokenId}`); },
  };
  return { client, log, state };
}

const input = { accountId: "acct", zoneId: "zone", hostname: "hermes.example.com", tunnelName: "openedbot-hermes-hermes", accessName: "openedbot Hermes hermes.example.com" };

describe("direct exposure provisioning", () => {
  test("creates tunnel, ingress, CNAME, Access app, service token and policy, then reads the install token", async () => {
    const { client, log } = fakeCloudflare();
    const result = await provisionDirectExposure(client, input);
    expect(result).toMatchObject({ tunnelId: "tun-new", dnsRecordId: "rec-1", accessAppId: "app-1", serviceTokenId: "st-1", edgeAuth: { clientId: "cid", clientSecret: "csecret" } });
    expect(result.installToken.startsWith("install-token-")).toBe(true);
    expect(log).toEqual([
      "findTunnel:openedbot-hermes-hermes", "createTunnel:openedbot-hermes-hermes", "ingress:tun-new:hermes.example.com:http://127.0.0.1:8642",
      "findDns:hermes.example.com", "cname:hermes.example.com:tun-new", "findApp:hermes.example.com", "createApp:hermes.example.com",
      "createToken:openedbot Hermes hermes.example.com", "policy:app-1:st-1", "token:tun-new",
    ]);
  });

  test("is idempotent by name: an existing tunnel is reused, not recreated", async () => {
    const { client, log } = fakeCloudflare({ existingTunnel: true });
    const result = await provisionDirectExposure(client, input);
    expect(result.tunnelId).toBe("tun-existing");
    expect(log.some((entry) => entry.startsWith("createTunnel"))).toBe(false);
  });

  test("a failure after partial creation rolls back only what this pass created, then rethrows", async () => {
    const { client, log, state } = fakeCloudflare({ existingTunnel: true, failAt: "createServiceAuthPolicy" });
    await expect(provisionDirectExposure(client, input)).rejects.toBeInstanceOf(CloudflareApiError);
    expect(log.filter((entry) => entry.startsWith("delete"))).toEqual(["deleteToken:st-1", "deleteApp:app-1", "deleteDns:rec-1"]);
    // The pre-existing tunnel is not ours to delete.
    expect(state.tunnels).toEqual(["tun-existing"]);
  });

  test("deprovision tolerates absent resources and still reports another failure", async () => {
    const { client, log } = fakeCloudflare();
    client.deleteAccessApp = async () => { throw new CloudflareApiError("CLOUDFLARE_NOT_FOUND", 404, "gone"); };
    client.deleteTunnel = async () => { throw new CloudflareApiError("CLOUDFLARE_UNAVAILABLE", 502, "down"); };
    await expect(deprovisionDirectExposure(client, { accountId: "acct", zoneId: "zone", tunnelId: "tun", dnsRecordId: "rec", accessAppId: "app", serviceTokenId: "st" }))
      .rejects.toMatchObject({ code: "CLOUDFLARE_UNAVAILABLE" });
    expect(log).toEqual(["deleteToken:st", "deleteDns:rec"]);
  });
});
