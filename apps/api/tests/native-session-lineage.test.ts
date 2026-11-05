import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { refreshNativeSession } from "@openedbot/identity/application/native-auth";
import { replacePasswordRevokingOtherSessions } from "@openedbot/identity/sql/accounts";
import {
  createNativeSession,
  listUserSessions,
  revokeOtherUserSessions,
  revokeUserSession,
} from "@openedbot/identity/sql/sessions";

/**
 * La coque openedbot-desktop tourne son refresh token toutes les 15 minutes. Chaque
 * rotation insère une ligne : l'écran « Sécurité du compte » ne doit y voir
 * qu'UNE connexion, avec son appareil, son adresse et sa date d'ouverture.
 */

const OPENED_AT = new Date("2026-10-10T17:08:00.000Z");

type Rotated = {
  id: string;
  organizationId: string;
  userId: string;
  familyId: string | null;
  createdAt: Date;
  userAgent: string | null;
  ip: string | null;
};

function fakeDb(options: { calls: string[]; bindings: unknown[][]; rotated?: Rotated | null; transactions?: { count: number } }): SQL {
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    options.calls.push(sql);
    options.bindings.push(values);
    if (sql.includes("where refresh_token_hash =")) {
      return Promise.resolve(options.rotated === undefined || options.rotated === null ? [] : [options.rotated]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => {
      if (options.transactions) options.transactions.count += 1;
      return callback(query);
    };
  return query;
}

function insertedRow(calls: string[], bindings: unknown[][]): unknown[] {
  const index = calls.findIndex((sql) => sql.includes("insert into sessions"));
  expect(index).toBeGreaterThanOrEqual(0);
  return bindings[index] ?? [];
}

describe("createNativeSession", () => {
  test("une première ouverture pose sa famille, sa date et l'appareil", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const before = Date.now();
    await createNativeSession(fakeDb({ calls, bindings }), "org-1", "user-1", {
      userAgent: "openedbot/0.1.0 Electron/44",
      ip: "203.0.113.7",
    });
    const row = insertedRow(calls, bindings);
    expect(row).toContain("openedbot/0.1.0 Electron/44");
    expect(row).toContain("203.0.113.7");
    const createdAt = row.find((value): value is Date => value instanceof Date && value.getTime() >= before
      && value.getTime() <= Date.now());
    expect(createdAt).toBeDefined();
  });

  test("une rotation reprend la famille et la date d'ouverture", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    await createNativeSession(fakeDb({ calls, bindings }), "org-1", "user-1", { userAgent: null, ip: null }, {
      familyId: "family-1",
      createdAt: OPENED_AT,
    });
    const row = insertedRow(calls, bindings);
    expect(row).toContain("family-1");
    expect(row).toContain(OPENED_AT);
  });
});

describe("refreshNativeSession", () => {
  const rotated: Rotated = {
    id: "session-old",
    organizationId: "org-1",
    userId: "user-1",
    familyId: "family-1",
    createdAt: OPENED_AT,
    userAgent: "openedbot/0.1.0 Electron/44",
    ip: "198.51.100.4",
  };

  test("la nouvelle ligne garde la connexion d'origine et prend l'adresse de la requête", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    await refreshNativeSession(fakeDb({ calls, bindings, rotated }), "refresh-token", {
      userAgent: "openedbot/0.1.0 Electron/44",
      ip: "203.0.113.9",
    });
    expect(calls.some((sql) => sql.includes("revoked_reason = 'refresh_rotation'"))).toBe(true);
    const row = insertedRow(calls, bindings);
    expect(row).toContain("family-1");
    expect(row).toContain(OPENED_AT);
    expect(row).toContain("203.0.113.9");
  });

  test("sans appareil dans la requête, l'appareil connu est gardé", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    await refreshNativeSession(fakeDb({ calls, bindings, rotated }), "refresh-token", { userAgent: null, ip: null });
    const row = insertedRow(calls, bindings);
    expect(row).toContain("openedbot/0.1.0 Electron/44");
    expect(row).toContain("198.51.100.4");
  });

  test("une session d'avant la famille en ouvre une, sans reprendre de date", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    await refreshNativeSession(fakeDb({ calls, bindings, rotated: { ...rotated, familyId: null } }), "refresh-token", {
      userAgent: null,
      ip: null,
    });
    const row = insertedRow(calls, bindings);
    expect(row).not.toContain(OPENED_AT);
  });

  test("tourne en une transaction, sous le verrou du compte pris avant la ligne", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    const transactions = { count: 0 };
    await refreshNativeSession(fakeDb({ calls, bindings, rotated, transactions }), "refresh-token", { userAgent: null, ip: null });
    expect(transactions.count).toBe(1);
    const step = (fragment: string) => calls.findIndex((sql) => sql.includes(fragment));
    const lock = step("pg_advisory_xact_lock");
    expect(bindings[lock]).toEqual(["user-1"]);
    expect(step("select user_id")).toBeLessThan(lock);
    expect(lock).toBeLessThan(step("for update"));
    expect(step("for update")).toBeLessThan(step("revoked_reason = 'refresh_rotation'"));
    expect(step("revoked_reason = 'refresh_rotation'")).toBeLessThan(step("insert into sessions"));
  });

  test("un refresh token inconnu reste un 401", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    await expect(refreshNativeSession(fakeDb({ calls, bindings, rotated: null }), "nope", { userAgent: null, ip: null }))
      .rejects.toMatchObject({ status: 401, code: "REFRESH_TOKEN_INVALID" });
    expect(calls.some((sql) => sql.includes("insert into sessions"))).toBe(false);
  });
});

describe("listUserSessions", () => {
  test("lit les sessions natives, sans les étapes de rotation", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    await listUserSessions(fakeDb({ calls, bindings }), "user-1");
    const list = calls.find((sql) => sql.includes("select id, kind, created_at"));
    expect(list).toBeDefined();
    expect(list).toContain("kind = 'native' and revoked_reason is distinct from 'refresh_rotation'");
    expect(list).not.toContain("and kind = 'web' and");
  });
});

describe("révocations", () => {
  const cases: Array<[string, (db: SQL) => Promise<unknown>, string]> = [
    ["autres sessions", (db) => revokeOtherUserSessions(db, "user-1", "session-current"), "update sessions"],
    ["une session", (db) => revokeUserSession(db, "user-1", "session-1"), "update sessions"],
    ["mot de passe", (db) => replacePasswordRevokingOtherSessions(db, "user-1", "hash", "session-current"), "update users"],
  ];
  for (const [name, revoke, firstWrite] of cases) {
    test(`${name} : le verrou de la rotation est pris avant toute écriture`, async () => {
      const calls: string[] = [];
      const bindings: unknown[][] = [];
      await revoke(fakeDb({ calls, bindings }));
      const lock = calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock(hashtext( ), hashtext('openedbot-user-sessions'))"));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(bindings[lock]).toEqual(["user-1"]);
      expect(lock).toBeLessThan(calls.findIndex((sql) => sql.includes(firstWrite)));
    });
  }

  test("révoquer une session native atteint sa remplaçante de la même famille", async () => {
    const calls: string[] = [];
    const bindings: unknown[][] = [];
    await revokeUserSession(fakeDb({ calls, bindings }), "user-1", "session-1");
    expect(calls.find((sql) => sql.includes("update sessions"))).toContain("or family_id = ( select family_id from sessions");
  });
});
