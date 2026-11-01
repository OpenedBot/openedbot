import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { ApnsConfig } from "@openedbot/platform-integrations/apns";
import { ApnsTransportError, createApnsTransport, signProviderToken, type ApnsRequest } from "../src/application/apns-transport";
import { startFakeApns, type FakeApnsServer } from "../../../tests/fake-apns/server";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const TOKEN = "0f".repeat(32);

let fake: FakeApnsServer;
let config: ApnsConfig;

function request(overrides: Partial<ApnsRequest> = {}): ApnsRequest {
  return {
    environment: "sandbox",
    deviceToken: TOKEN,
    topic: "app.openedbot.mobile",
    apnsId: "5b0c6c1e-8f3a-4d55-9a3e-2f1e0d9c8b7a",
    collapseId: "workflow:wf-1",
    priority: 5,
    expiration: Math.floor(Date.now() / 1_000) + 60,
    payload: JSON.stringify({ aps: { alert: { title: "t", body: "b" } } }),
    ...overrides,
  };
}

beforeAll(async () => {
  fake = await startFakeApns({ port: 0, publicKey: keys.publicKey, keyId: "KEYID00001", teamId: "TEAMID0001" });
  config = {
    keyId: "KEYID00001",
    teamId: "TEAMID0001",
    privateKey: keys.privateKey,
    bundleIds: ["app.openedbot.mobile"],
    hostOverride: fake.url,
  };
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => fake.reset());

describe("createApnsTransport against the fake APNs (HTTP/2)", () => {
  test("sends the APNs headers with a verifiable ES256 provider token", async () => {
    const transport = createApnsTransport(config);
    try {
      const response = await transport.send(request({ priority: 10, collapseId: "approval:wf-1:2" }));
      expect(response).toEqual({ status: 200, reason: null });
      const [delivery] = fake.journal();
      expect(delivery).toMatchObject({
        token: TOKEN,
        topic: "app.openedbot.mobile",
        pushType: "alert",
        priority: "10",
        collapseId: "approval:wf-1:2",
        apnsId: "5b0c6c1e-8f3a-4d55-9a3e-2f1e0d9c8b7a",
        status: 200,
      });
    } finally {
      transport.close();
    }
  });

  test("reads the APNs reason of an error and reuses one session for several streams", async () => {
    const transport = createApnsTransport(config);
    try {
      fake.script({ status: 410, reason: "Unregistered" });
      fake.script({ status: 400, reason: "BadDeviceToken" });
      const [first, second, third] = await Promise.all([
        transport.send(request()),
        transport.send(request()),
        transport.send(request()),
      ]);
      expect([first, second, third].map((response) => `${response.status}:${response.reason}`).sort())
        .toEqual(["200:null", "400:BadDeviceToken", "410:Unregistered"]);
    } finally {
      transport.close();
    }
  });

  test("caches the provider token, and re-signs after invalidation once it is old enough", async () => {
    let now = Date.now() - 120_000;
    const transport = createApnsTransport(config, { now: () => now });
    const issuedAt = () => fake.journal().map((delivery) => delivery.providerIssuedAt);
    try {
      await transport.send(request());
      now += 10_000;
      await transport.send(request());
      // A token signed less than a minute ago is kept even after a 403:
      // Apple refuses tokens re-signed too often.
      transport.invalidateProviderToken();
      now += 5_000;
      await transport.send(request());
      now += 61_000;
      await transport.send(request());
      const [first, second, third, fourth] = issuedAt();
      expect(second).toBe(first!);
      expect(third).toBe(first!);
      expect(fourth).toBeGreaterThan(first!);
      expect(fake.journal().every((delivery) => delivery.status === 200)).toBe(true);
    } finally {
      transport.close();
    }
  });

  test("a wrong signing key is refused by the provider-token check", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const transport = createApnsTransport({ ...config, privateKey: other.privateKey });
    try {
      expect(await transport.send(request())).toEqual({ status: 403, reason: "InvalidProviderToken" });
    } finally {
      transport.close();
    }
  });

  test("a silent server is a Timeout, an unreachable one a NetworkError", async () => {
    const transport = createApnsTransport(config, { timeoutMs: 100 });
    try {
      fake.script({ status: 200, delayMs: 1_000 });
      const timedOut = await transport.send(request()).catch((error: unknown) => error);
      expect(timedOut).toBeInstanceOf(ApnsTransportError);
      expect((timedOut as ApnsTransportError).code).toBe("Timeout");
    } finally {
      transport.close();
    }
    const unreachable = createApnsTransport({ ...config, hostOverride: "http://127.0.0.1:1" }, { timeoutMs: 2_000 });
    try {
      const failed = await unreachable.send(request()).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(ApnsTransportError);
      expect((failed as ApnsTransportError).code).toBe("NetworkError");
    } finally {
      unreachable.close();
    }
  });

  test("the provider token carries kid and iss, nothing else", () => {
    const token = signProviderToken(config, 1_700_000_000);
    const [header, claims] = token.split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    expect(header).toEqual({ alg: "ES256", kid: "KEYID00001" });
    expect(claims).toEqual({ iss: "TEAMID0001", iat: 1_700_000_000 });
  });
});
