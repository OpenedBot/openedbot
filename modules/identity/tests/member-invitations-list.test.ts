import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { listMemberInvitations } from "../src/application/member-invitations";

const ORG = "87000000-0000-4000-8000-000000000001";
const actor = { organizationId: ORG, userId: "87000000-0000-4000-8000-0000000000aa" };

/** The inviter is an owner; the listing answers `available` actionable rows, at most what the SQL asked. */
function fakeDb(available: number, calls: Array<{ sql: string; values: unknown[] }>): SQL {
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join("?").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.startsWith("select name from organizations")) return Promise.resolve([{ name: "Team" }]);
    if (sql.startsWith("select role from memberships")) return Promise.resolve([{ role: "owner" }]);
    if (sql.startsWith("select id, email, role, status")) {
      const limit = Number(values.at(-1));
      return Promise.resolve(Array.from({ length: Math.min(available, limit) }, (_, index) => ({
        id: `inv-${index}`, email: `p${index}@example.test`, role: "member", status: "pending", expiresAt: new Date("2026-12-01T00:00:00Z"),
      })));
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

describe("listing member invitations", () => {
  test("only actionable statuses are read, filtered before the limit", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    await listMemberInvitations(fakeDb(0, calls), actor);
    const listing = calls.find((call) => call.sql.startsWith("select id, email, role, status"))!.sql;
    const filter = listing.indexOf("status in ('pending', 'expired')");
    expect(filter).toBeGreaterThan(0);
    expect(filter).toBeLessThan(listing.indexOf("limit"));
  });

  test("within the limit: everything, not truncated", async () => {
    const result = await listMemberInvitations(fakeDb(3, []), actor, { limit: 3 });
    expect(result.invitations).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  test("beyond the limit: the limit, and says it is truncated", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const result = await listMemberInvitations(fakeDb(5, calls), actor, { limit: 3 });
    expect(result.invitations.map((invitation) => invitation.id)).toEqual(["inv-0", "inv-1", "inv-2"]);
    expect(result.truncated).toBe(true);
    // One row past the limit is asked for, to know without counting.
    expect(calls.find((call) => call.sql.startsWith("select id, email, role, status"))!.values.at(-1)).toBe(4);
  });
});
