import { afterEach, expect, test } from "bun:test";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { readApiConfig } from "@openedbot/platform-config/api-config";
import type { RuntimeExposureRow } from "../src/application/runtime-exposures";
import { cleanupRevokedExposuresAfterCommit, markExposureRevoked } from "../src/application/direct-exposure-lifecycle";
import { installManagedExposure } from "../src/application/managed-exposure";

const config = readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });
const row: RuntimeExposureRow = {
  id: "exposure", organizationId: "organization", runtimeId: "runtime", kind: "managed_cloudflare",
  hostname: "host.example.test", endpoint: "https://host.example.test", cloudflareAccountId: "account", zoneId: "zone",
  tunnelId: "tunnel", dnsRecordId: "dns", accessAppId: "access", serviceTokenId: "service", tailscaleAuthKeyId: null,
  installTokenCiphertext: null, installTokenNonce: null, installTokenTag: null, installTokenKeyId: null,
  edgeAuthCiphertext: null, edgeAuthNonce: null, edgeAuthTag: null, edgeAuthKeyId: null,
  status: "revoked", lastTunnelStatus: null, lastCheckedAt: null, errorCode: null,
  createdAt: new Date(), revokedAt: new Date(), cleanupStatus: "pending",
};
function database() {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const tx = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    writes.push({ sql: parts.join("?").replace(/\s+/g, " ").trim(), values });
    return [];
  }) as unknown as TransactionDb;
  const db = { begin: (work: (tx: TransactionDb) => Promise<unknown>) => work(tx) } as unknown as Db;
  return { db, tx, writes };
}
afterEach(() => installManagedExposure(null));

test("missing provider leaves managed cleanup pending, warns, then resumes when reinstalled", async () => {
  installManagedExposure(null);
  const { db, tx, writes } = database();
  expect(await markExposureRevoked(tx, config, row, null)).toBe("pending");
  expect(writes[0]?.values).toContain("pending");
  expect(writes[0]?.sql).not.toMatch(/tunnel_id\s*=|dns_record_id\s*=/);
  writes.length = 0;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (value) => warnings.push(String(value));
  try { await cleanupRevokedExposuresAfterCommit(db, config, [row]); } finally { console.warn = original; }
  expect(writes).toHaveLength(0);
  expect(warnings).toHaveLength(1);
  expect(JSON.parse(warnings[0]!)).toMatchObject({ event: "api.exposure_cleanup_deferred", reason: "provider_unavailable", exposureId: row.id });

  const cleaned: unknown[] = [];
  installManagedExposure({ create: async () => { throw new Error("not a creation"); }, cleanup: async (resources) => { cleaned.push(resources); } });
  await cleanupRevokedExposuresAfterCommit(db, config, [row]);
  expect(cleaned).toEqual([{ accountId: "account", zoneId: "zone", tunnelId: "tunnel", dnsRecordId: "dns", accessAppId: "access", serviceTokenId: "service" }]);
  expect(writes.some((write) => write.sql.includes("cleanup_status = 'done'"))).toBe(true);
});

test("provider failure never marks a cleanup done or discards resource identifiers", async () => {
  const { db, writes } = database();
  installManagedExposure({ create: async () => { throw new Error("not a creation"); }, cleanup: async () => { throw new Error("provider offline"); } });
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (value) => warnings.push(String(value));
  try { await cleanupRevokedExposuresAfterCommit(db, config, [row]); } finally { console.warn = original; }
  expect(writes).toHaveLength(0);
  expect(row.cleanupStatus).toBe("pending");
  expect(row.tunnelId).toBe("tunnel");
  expect(JSON.parse(warnings[0]!)).toMatchObject({ event: "api.exposure_cleanup_deferred", exposureId: row.id });
});
