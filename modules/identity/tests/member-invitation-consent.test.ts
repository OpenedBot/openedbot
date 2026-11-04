import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { respondToMemberInvitation } from "../src/application/member-invitation-consent";

const TOKEN = "a".repeat(43);

/** Base factice : une invitation en attente vers une organisation d'équipe. */
function fakeDb(options: { calls: string[]; deletionScheduled: boolean }): SQL {
  const tx = ((strings: TemplateStringsArray) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    options.calls.push(sql);
    if (sql.includes("select organization_id as \"organizationId\" from organization_member_invitations")) {
      return Promise.resolve([{ organizationId: "org-1" }]);
    }
    if (sql.includes("select name from organizations")) return Promise.resolve([{ name: "Acme" }]);
    if (sql.includes("from tenant_deletions")) return Promise.resolve(options.deletionScheduled ? [{ "?column?": 1 }] : []);
    if (sql.includes("from organization_member_invitations where token_hash")) {
      return Promise.resolve([{
        id: "invitation-1", organizationId: "org-1", email: "new@example.test", role: "member",
        expiresAt: new Date(Date.now() + 60_000),
      }]);
    }
    if (sql.includes("select email from users")) return Promise.resolve([{ email: "new@example.test" }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

describe("acceptation d'une invitation de membre", () => {
  test("refusée quand la purge de l'organisation est programmée, lue sous le verrou de l'organisation", async () => {
    const calls: string[] = [];
    await expect(respondToMemberInvitation(fakeDb({ calls, deletionScheduled: true }), {
      token: TOKEN, userId: "user-2", accept: true,
    })).rejects.toMatchObject({ status: 410, code: "MEMBER_INVITATION_UNAVAILABLE" });
    const lock = calls.findIndex((sql) => sql.includes("select name from organizations") && sql.includes("for no key update"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(calls.findIndex((sql) => sql.includes("from tenant_deletions")));
    expect(calls.some((sql) => sql.includes("insert into memberships"))).toBe(false);
  });

  test("acceptée sans purge programmée", async () => {
    const calls: string[] = [];
    const result = await respondToMemberInvitation(fakeDb({ calls, deletionScheduled: false }), {
      token: TOKEN, userId: "user-2", accept: true,
    });
    expect(result).toEqual({ status: "accepted", organizationId: "org-1" });
    expect(calls.some((sql) => sql.includes("insert into memberships"))).toBe(true);
  });
});
