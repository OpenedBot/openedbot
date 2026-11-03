import { describe, expect, test } from "bun:test";
import { matchRelayRoute } from "@openedbot/contracts-connector";
import { HermesClient, HermesClientError } from "../src";
import { parseA2APolicyView, parseA2APolicyWriteStatus } from "../src/a2a-policy";
import type { A2APolicyView } from "../src/contracts";

const peer = {
  name: "alpha",
  identity: "alpha",
  tokenPresent: true,
  access: "allow",
  outgoingConfigured: true,
  outgoingTokenPresent: true,
  outgoingAccess: "allow",
} as const;

const view = (): A2APolicyView => ({
  accessMode: "trusted_peers",
  trustedPeersSource: "environment",
  processObserved: true,
  peers: [peer],
});

describe("A2A named-peer policy SDK", () => {
  test("projects only bounded metadata and drops credentials, URLs, and unknown fields", () => {
    const parsed = parseA2APolicyView({
      ...view(),
      token: "SECRET_TOKEN",
      url: "https://private.example/?secret=1",
      peers: [{ ...peer, auth: { token: "PEER_SECRET" }, endpoint: "https://private.example" }],
    });
    expect(parsed).toEqual(view());
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET_TOKEN|PEER_SECRET|private\.example|auth|endpoint/);
  });

  test("accepts bounded IP identities and fails closed when process state is not observed", () => {
    expect(parseA2APolicyView({
      accessMode: "localhost_only",
      trustedPeersSource: "none",
      processObserved: false,
      peers: [{
        identity: "ip:127.0.0.1",
        tokenPresent: false,
        access: "deny",
        outgoingConfigured: false,
        outgoingTokenPresent: false,
        outgoingAccess: "deny",
      }],
    }).peers[0]?.identity).toBe("ip:127.0.0.1");

    expect(() => parseA2APolicyView({
      accessMode: "default_allow",
      trustedPeersSource: "none",
      processObserved: false,
      peers: [{ ...peer, identity: "alpha" }],
    })).toThrow();
  });

  test("keeps file-only token presence while denying unobserved effective access", () => {
    const parsed = parseA2APolicyView({
      accessMode: "trusted_peers",
      trustedPeersSource: "config",
      processObserved: false,
      peers: [{
        name: "alpha",
        identity: "alpha",
        tokenPresent: true,
        access: "deny",
        outgoingConfigured: true,
        outgoingTokenPresent: true,
        outgoingAccess: "deny",
      }],
    });
    expect(parsed.peers[0]).toMatchObject({ tokenPresent: true, outgoingTokenPresent: true, outgoingAccess: "deny" });
  });

  test("rejects malformed, duplicate, oversized, and path-dangerous peer metadata", () => {
    expect(() => parseA2APolicyView({ ...view(), peers: Array.from({ length: 97 }, (_, i) => ({
      ...peer, name: `peer${i}`, identity: `peer${i}`,
    })) })).toThrow();
    expect(() => parseA2APolicyView({ ...view(), peers: [peer, peer] })).toThrow();
    expect(() => parseA2APolicyView({ ...view(), peers: [{ ...peer, name: "UPPER", identity: "alpha" }] })).toThrow();
    expect(() => parseA2APolicyView({ ...view(), peers: [{ ...peer, identity: "ip:not-an-ip" }] })).toThrow();
    expect(() => parseA2APolicyView({ ...view(), peers: [{ ...peer, identity: "a..b" }] })).toThrow();
    expect(() => parseA2APolicyView({ ...view(), peers: [{ ...peer, name: "beta", identity: "alpha" }] })).toThrow();
    expect(() => parseA2APolicyView({ ...view(), peers: [{ ...peer, name: "alpha", identity: "ip:127.0.0.1" }] })).toThrow();
    expect(() => parseA2APolicyView({ ...view(), accessMode: ["default_allow"] })).toThrow();
    expect(() => parseA2APolicyView({ ...view(), trustedPeersSource: ["config"] })).toThrow();
  });

  test("accepts upstream no-address identity sentinels without giving them a peer name", () => {
    const parsed = parseA2APolicyView({
      accessMode: "localhost_only",
      trustedPeersSource: "none",
      processObserved: true,
      peers: ["ip:local", "ip:unknown"].map((identity) => ({
        identity,
        tokenPresent: false,
        access: "allow",
        outgoingConfigured: false,
        outgoingTokenPresent: false,
        outgoingAccess: "deny",
      })),
    });
    expect(parsed.peers.map((item) => item.identity)).toEqual(["ip:local", "ip:unknown"]);
  });

  test("requires coherent persisted/effective/restart readback", () => {
    expect(parseA2APolicyWriteStatus({ persisted: true, effective: false, needsGatewayRestart: true }))
      .toEqual({ persisted: true, effective: false, needsGatewayRestart: true });
    expect(parseA2APolicyWriteStatus({ persisted: true, effective: true, needsGatewayRestart: false }))
      .toEqual({ persisted: true, effective: true, needsGatewayRestart: false });
    for (const status of [
      { persisted: false, effective: true, needsGatewayRestart: false },
      { persisted: false, effective: false, needsGatewayRestart: true },
      { persisted: true, effective: false, needsGatewayRestart: false },
      { persisted: true, effective: true, needsGatewayRestart: true },
    ]) expect(() => parseA2APolicyWriteStatus(status)).toThrow();
  });

  test("reads only the fixed host-root policy route", async () => {
    const requests: Array<{ path: string; method?: string; kind: string }> = [];
    const client = new HermesClient({ profile: "specialist", transport: {
      kind: "relay",
      async send(path, init, kind) {
        requests.push({ path, method: init.method, kind });
        return Response.json(view());
      },
    } });
    expect(await client.a2aPolicy()).toEqual(view());
    expect(requests).toEqual([{ path: "/hermes-setup/a2a/peers", method: "GET", kind: "safe" }]);
  });

  test("writes use fixed named routes, exact bodies, mutation classification, and no query", async () => {
    const requests: Array<{ path: string; method?: string; body?: string | null; kind: string }> = [];
    const client = new HermesClient({ profile: "specialist", transport: {
      kind: "relay",
      async send(path, init, kind) {
        requests.push({ path, method: init.method, body: init.body as string | null, kind });
        return Response.json({ persisted: true, effective: false, needsGatewayRestart: true });
      },
    } });
    const token = "0123456789abcdef0123456789abcdef";
    expect(await client.a2aTrustPeer("alpha", true)).toEqual({ persisted: true, effective: false, needsGatewayRestart: true });
    expect(await client.a2aSetPeerToken("alpha", token)).toEqual({ persisted: true, effective: false, needsGatewayRestart: true });
    expect(await client.a2aDeletePeerToken("alpha")).toEqual({ persisted: true, effective: false, needsGatewayRestart: true });
    expect(requests).toEqual([
      { path: "/hermes-setup/a2a/peers/alpha/trust", method: "POST", body: '{"trusted":true}', kind: "mutation" },
      { path: "/hermes-setup/a2a/peers/alpha/token", method: "POST", body: JSON.stringify({ token }), kind: "mutation" },
      { path: "/hermes-setup/a2a/peers/alpha/token", method: "DELETE", body: undefined, kind: "mutation" },
    ]);
  });

  test("rejects invalid aliases and tokens before any transport call", async () => {
    let calls = 0;
    const client = new HermesClient({ profile: "specialist", transport: {
      kind: "relay",
      async send() { calls += 1; return Response.json({ persisted: true, effective: true, needsGatewayRestart: false }); },
    } });
    await expect(client.a2aTrustPeer("../outside", true)).rejects.toBeInstanceOf(RangeError);
    await expect(client.a2aSetPeerToken("peer..name", "x".repeat(32))).rejects.toBeInstanceOf(RangeError);
    for (const token of ["x".repeat(31), "x".repeat(257), "x".repeat(31) + ","]) {
      await expect(client.a2aSetPeerToken("alpha", token)).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toBe(0);
  });

  test("sanitizes token-write transport and HTTP errors", async () => {
    const secret = "DO_NOT_ECHO_THIS_TOKEN";
    const failed = new HermesClient({ profile: "specialist", transport: {
      kind: "relay",
      async send() { throw new Error(secret); },
    } });
    await expect(failed.a2aSetPeerToken("alpha", "x".repeat(32))).rejects.toMatchObject({
      code: "HOST_UNAVAILABLE",
      message: "The A2A policy write failed.",
    });

    const rejected = new HermesClient({ profile: "specialist", transport: {
      kind: "relay",
      async send() { return new Response(secret, { status: 403 }); },
    } });
    try {
      await rejected.a2aSetPeerToken("alpha", "x".repeat(32));
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HermesClientError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test("rejects oversized policy reads and write readbacks", async () => {
    const oversized = JSON.stringify(view()).padEnd(64 * 1024 + 1, " ");
    const client = new HermesClient({ profile: "specialist", transport: {
      kind: "relay",
      async send(_path, _init) {
        return new Response(oversized, { status: 200, headers: { "content-type": "application/json" } });
      },
    } });
    await expect(client.a2aPolicy()).rejects.toBeInstanceOf(HermesClientError);
    await expect(client.a2aTrustPeer("alpha", true)).rejects.toMatchObject({
      code: "HERMES_RESPONSE_INVALID",
      message: "The A2A policy write could not be verified.",
    });
  });

  test("bounds response size and allowlists root paths", () => {
    for (const [method, path] of [
      ["GET", "/hermes-setup/a2a/peers"],
      ["POST", "/hermes-setup/a2a/peers/alpha/trust"],
      ["POST", "/hermes-setup/a2a/peers/alpha/token"],
      ["DELETE", "/hermes-setup/a2a/peers/alpha/token"],
    ] as const) expect(matchRelayRoute(method, path)?.host).toBe(true);
    expect(matchRelayRoute("GET", "/p/specialist/hermes-setup/a2a/peers")).toBeNull();
    expect(matchRelayRoute("GET", "/hermes-setup/a2a/peers?x=1")).toBeNull();
    expect(matchRelayRoute("POST", "/hermes-setup/a2a/peers/../trust")).toBeNull();
  });
});
