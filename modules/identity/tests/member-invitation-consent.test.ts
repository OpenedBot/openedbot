import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { respondToMemberInvitation } from "../src/application/member-invitation-consent";

const TOKEN = "a".repeat(43);

/** Base factice : une invitation en attente vers l'espace personnel `org-1`. */
function fakeDb(options: { calls: string[]; deletionScheduled?: boolean; otherWorkspace?: "owner" | "member" }): SQL {
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
    if (sql.startsWith("select organization_id as \"organizationId\", role from memberships")) {
      return Promise.resolve(options.otherWorkspace ? [{ organizationId: "org-2", role: options.otherWorkspace }] : []);
    }
    if (sql.startsWith("select id from organizations")) return Promise.resolve([{ id: "org-2" }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

const accept = (db: SQL) => respondToMemberInvitation(db, { token: TOKEN, userId: "user-2", accept: true });

describe("acceptation d'une invitation de membre", () => {
  test("refusée quand la purge de l'organisation est programmée, lue sous le verrou de l'organisation", async () => {
    const calls: string[] = [];
    await expect(accept(fakeDb({ calls, deletionScheduled: true })))
      .rejects.toMatchObject({ status: 410, code: "MEMBER_INVITATION_UNAVAILABLE" });
    const lock = calls.findIndex((sql) => sql.includes("select name from organizations") && sql.includes("for no key update"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(calls.findIndex((sql) => sql.includes("from tenant_deletions")));
    expect(calls.some((sql) => sql.includes("insert into memberships"))).toBe(false);
  });

  test("ne vise qu'un espace personnel", async () => {
    const calls: string[] = [];
    await accept(fakeDb({ calls }));
    expect(calls.find((sql) => sql.includes("select name from organizations"))).toContain("kind = 'personal'");
  });

  test("acceptée : le rôle invité, sous le verrou du compte, et l'accueil marqué fait", async () => {
    const calls: string[] = [];
    const result = await accept(fakeDb({ calls }));
    expect(result).toEqual({ status: "accepted", organizationId: "org-1" });
    const lock = calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const insert = calls.findIndex((sql) => sql.includes("insert into memberships"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(lock);
    expect(calls.some((sql) => sql.startsWith("update users set onboarding_completed = true"))).toBe(true);
    // No workspace is ever created for the invitee.
    expect(calls.some((sql) => sql.includes("insert into organizations"))).toBe(false);
  });

  // Same order as `createOrganization` (account lock, then the inserts whose
  // foreign key locks the user row): the reverse order deadlocked.
  for (const accepted of [true, false]) {
    test(`le verrou du compte précède le verrou de la ligne users (${accepted ? "accept" : "decline"})`, async () => {
      const calls: string[] = [];
      await respondToMemberInvitation(fakeDb({ calls }), { token: TOKEN, userId: "user-2", accept: accepted });
      const accountLock = calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
      const userRow = calls.findIndex((sql) => sql.startsWith("select email from users"));
      expect(accountLock).toBeGreaterThanOrEqual(0);
      expect(userRow).toBeGreaterThan(accountLock);
      expect(calls[userRow]).toContain("for no key update");
      expect(calls.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(1);
    });
  }

  for (const role of ["owner", "member"] as const) {
    test(`refusée en 409 quand le compte est déjà ${role} d'un autre espace vivant`, async () => {
      const calls: string[] = [];
      await expect(accept(fakeDb({ calls, otherWorkspace: role })))
        .rejects.toMatchObject({ status: 409, code: "MEMBER_ALREADY_IN_WORKSPACE" });
      expect(calls.some((sql) => sql.includes("insert into memberships") || sql.includes("update memberships"))).toBe(false);
      expect(calls.some((sql) => sql.includes("set status = 'accepted'"))).toBe(false);
    });
  }

  test("un refus n'est pas bloqué par un autre espace", async () => {
    const calls: string[] = [];
    const result = await respondToMemberInvitation(fakeDb({ calls, otherWorkspace: "owner" }), { token: TOKEN, userId: "user-2", accept: false });
    expect(result).toEqual({ status: "declined", organizationId: null });
  });

  test("un jeton mal formé est indisponible sans toucher la base", async () => {
    const calls: string[] = [];
    await expect(respondToMemberInvitation(fakeDb({ calls }), { token: "short", userId: "user-2", accept: true }))
      .rejects.toMatchObject({ status: 410 });
    expect(calls).toEqual([]);
  });
});
