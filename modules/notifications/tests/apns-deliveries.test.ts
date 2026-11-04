import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { encryptSecret, secretEncryptionKey } from "@openedbot/hermes/secrets";
import { processApnsDeliveries } from "../src/application/apns-deliveries";
import type { ApnsRequest, ApnsTransport } from "../src/application/apns-transport";

const keyring = { current: secretEncryptionKey(new Uint8Array(32).fill(7)), previous: [] };
const BUNDLE_ID = "app.openedbot.ios";
const APNS = {
  keyId: "ABCDEFGHIJ",
  teamId: "KLMNOPQRST",
  privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
  bundleIds: [BUNDLE_ID],
  hostOverride: null,
};
const SENT_TOKEN_HASH = "a".repeat(64);

type Query = { sql: string; values: unknown[] };

/** One claimable delivery whose device holds the token `SENT_TOKEN_HASH`. */
function fakeDb(state: { queries: Query[]; revokeMatches: boolean }): Bun.SQL {
  let claimed = false;
  const token = encryptSecret("device-token-old", keyring.current.value);
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    state.queries.push({ sql, values });
    if (sql.includes("with candidate as")) {
      if (claimed) return Promise.resolve([]);
      claimed = true;
      return Promise.resolve([{
        id: "delivery-1",
        organizationId: "org-1",
        deviceId: "device-1",
        attempts: 1,
        workflowId: "wf-1",
        notificationSequence: 3,
        eventType: "run.completed",
        botName: "SEO Geo",
        workflowKind: "dm",
        threadId: "thread-1",
        groupName: null,
      }]);
    }
    if (sql.includes("from apns_devices d")) {
      return Promise.resolve([{
        id: "device-1",
        bundleId: BUNDLE_ID,
        environment: "production",
        revoked: false,
        memberActive: true,
        tokenHash: SENT_TOKEN_HASH,
        ciphertext: token.ciphertext,
        nonce: token.nonce,
        tag: token.tag,
        keyId: keyring.current.id,
      }]);
    }
    if (sql.startsWith("update apns_devices set revoked_at = now()")) {
      return Promise.resolve(state.revokeMatches ? [{ id: "device-1" }] : []);
    }
    if (sql.startsWith("update apns_deliveries set status =")) return Promise.resolve([{ id: "delivery-1" }]);
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (query as unknown as { begin: (callback: (inner: Bun.SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: Bun.SQL) => unknown) => callback(query);
  return query;
}

function goneTransport(): ApnsTransport & { requests: ApnsRequest[] } {
  const requests: ApnsRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      return { status: 410, reason: "Unregistered" };
    },
    invalidateProviderToken() {},
    close() {},
  };
}

describe("processApnsDeliveries : révocation sur 410", () => {
  test("ne révoque que la version du jeton effectivement envoyée", async () => {
    const queries: Query[] = [];
    const transport = goneTransport();
    const result = await processApnsDeliveries(
      fakeDb({ queries, revokeMatches: true }),
      { apns: APNS, tokenEncryption: keyring, workerId: "worker-1" },
      transport,
    );
    expect(transport.requests.map((request) => request.deviceToken)).toEqual(["device-token-old"]);
    expect(result.revoked).toBe(1);
    const revoke = queries.find((q) => q.sql.startsWith("update apns_devices set revoked_at = now()"))!;
    expect(revoke.sql).toContain("and revoked_at is null and token_hash = returning id");
    expect(revoke.values.at(-1)).toBe(SENT_TOKEN_HASH);
  });

  test("jeton réenregistré pendant l'appel APNs : l'appareil reste actif, la livraison est close", async () => {
    const queries: Query[] = [];
    const result = await processApnsDeliveries(
      fakeDb({ queries, revokeMatches: false }),
      { apns: APNS, tokenEncryption: keyring, workerId: "worker-1" },
      goneTransport(),
    );
    expect(result.revoked).toBe(1);
    const finish = queries.find((q) => q.sql.startsWith("update apns_deliveries set status =") && q.sql.includes("last_http_status"));
    expect(finish?.values.slice(0, 3)).toEqual(["revoked", 410, "Unregistered"]);
  });
});
