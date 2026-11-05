import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { CloudflareApiError, type CloudflareApiClient } from "@openedbot/platform-integrations/cloudflare-api";
import { cleanupRevokedManagedExposures, reconcileManagedExposures } from "../src/application/managed-exposure-reconciliation";

const managed = { accountId: "acct", apiToken: "t".repeat(40), zoneId: "zone", hostSuffix: "rt.openedbot.app" };

function fakeDb(rows: Array<{ id: string; organizationId: string; accountId: string; tunnelId: string }>) {
  const updates: Array<{ sql: string; values: unknown[] }> = [];
  let pending = [...rows];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    if (sql.startsWith("select id")) return pending.length ? [pending.shift()!] : [];
    updates.push({ sql, values });
    return [];
  }) as unknown as SQL;
  const db = { begin: (fn: (inner: Bun.TransactionSQL) => Promise<unknown>) => fn(tx as unknown as Bun.TransactionSQL) } as unknown as SQL;
  return { db, updates };
}

test("without an openedbot Cloudflare account nothing is read", async () => {
  const { db, updates } = fakeDb([{ id: "e1", organizationId: "o1", accountId: "acct", tunnelId: "tun" }]);
  expect(await reconcileManagedExposures(db, null)).toBe(0);
  expect(updates).toHaveLength(0);
});

test("writes the Cloudflare tunnel status per exposure and a bounded code on failure, never a message", async () => {
  const { db, updates } = fakeDb([
    { id: "e1", organizationId: "o1", accountId: "acct", tunnelId: "tun-healthy" },
    { id: "e2", organizationId: "o2", accountId: "acct", tunnelId: "tun-broken" },
  ]);
  const client = {
    readTunnel: async (_account: string, tunnelId: string) => {
      if (tunnelId === "tun-broken") throw new CloudflareApiError("CLOUDFLARE_RATE_LIMITED", 429, "slow down: secret details");
      return { id: tunnelId, name: "x", status: "healthy", deletedAt: null };
    },
  } as unknown as CloudflareApiClient;
  expect(await reconcileManagedExposures(db, managed, client)).toBe(2);
  expect(updates).toHaveLength(2);
  expect(updates[0]!.values.slice(0, 3)).toEqual(["healthy", null, true]);
  expect(updates[1]!.values.slice(0, 3)).toEqual(["unknown", "CLOUDFLARE_RATE_LIMITED", false]);
  expect(JSON.stringify(updates)).not.toContain("secret details");
});

test("reprend le retrait des tunnels gérés révoqués : done au succès, code borné à l'échec", async () => {
  const revoked = (id: string, tunnelId: string) => ({
    id, organizationId: "o1", accountId: "acct", zoneId: "zone", tunnelId,
    dnsRecordId: "rec", accessAppId: null, serviceTokenId: null,
  });
  const updates: Array<{ sql: string; values: unknown[] }> = [];
  const selects: string[] = [];
  const pending = [revoked("e1", "tun-ok"), revoked("e2", "tun-broken")];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    if (sql.startsWith("select id")) { selects.push(sql); return pending.length ? [pending.shift()!] : []; }
    updates.push({ sql, values });
    return [];
  }) as unknown as SQL;
  const db = { begin: (fn: (inner: Bun.TransactionSQL) => Promise<unknown>) => fn(tx as unknown as Bun.TransactionSQL) } as unknown as SQL;
  const deleted: string[] = [];
  const client = {
    deleteDnsRecord: async (_zone: string, id: string) => { deleted.push(`dns:${id}`); },
    deleteTunnel: async (_account: string, id: string) => {
      if (id === "tun-broken") throw new CloudflareApiError("CLOUDFLARE_RATE_LIMITED", 429, "secret details");
      deleted.push(`tunnel:${id}`);
    },
  } as unknown as CloudflareApiClient;

  expect(await cleanupRevokedManagedExposures(db, managed, client)).toBe(2);
  expect(selects[0]).toContain("status = 'revoked' and cleanup_status = 'pending'");
  expect(deleted).toEqual(["dns:rec", "tunnel:tun-ok", "dns:rec"]);
  expect(updates[0]!.values[0]).toBeNull();
  expect(updates[1]!.values[0]).toBe("CLOUDFLARE_RATE_LIMITED");
  expect(JSON.stringify(updates)).not.toContain("secret details");
  expect(await cleanupRevokedManagedExposures(db, null, client)).toBe(0);
});
