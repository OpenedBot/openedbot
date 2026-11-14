import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  assertDevResetAllowed,
  DEV_RESET_PRESERVED_TABLES,
  performDevDataReset,
  resolveDevResetTables,
} from "../src/application/dev-reset";

/**
 * Fake SQL: each tagged call consumes the next fixture from `queues`, and
 * `unsafe` is recorded as-is, the only command built by
 * concatenation, so the only one to reread word for word.
 */
function fakeSql(queues: unknown[][], recorder: { statements: string[]; unsafe: string[] }): SQL {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    recorder.statements.push([...strings].join(" "));
    void values;
    return Promise.resolve(queues.shift() ?? []);
  };
  const fake = Object.assign(tag, {
    unsafe: (text: string) => {
      recorder.unsafe.push(text);
      return Promise.resolve([]);
    },
    begin: (callback: (tx: SQL) => Promise<unknown>) => callback(fake as unknown as SQL),
  }) as unknown as SQL;
  return fake;
}

describe("DEV_RESET_PRESERVED_TABLES", () => {
  test("garde la chaîne d'authentification : vider l'une d'elles déconnecterait la personne", () => {
    // `sessions` has an FK (organization_id, user_id) toward `memberships`, and
    // auth resolves the organization through that join (migrations/0001).
    for (const table of ["users", "organizations", "memberships", "sessions"]) {
      expect(DEV_RESET_PRESERVED_TABLES).toContain(table);
    }
    expect(DEV_RESET_PRESERVED_TABLES).toContain("schema_migrations");
    // The subscription is the account's state: without it, BILLING_ENFORCED=true in
    // dev would return 402/403 and make the new onboarding unusable.
    expect(DEV_RESET_PRESERVED_TABLES).toContain("subscriptions");
  });

  test("ne préserve aucune donnée applicative de l'accueil", () => {
    for (const table of ["bots", "threads", "messages", "runs", "sections", "routines"]) {
      expect(DEV_RESET_PRESERVED_TABLES).not.toContain(table);
    }
  });

  test("garde le runtime de dev relié : son connecteur ne serait plus reconnu sans la ligne `runtimes`", () => {
    for (const table of ["runtimes", "runtime_audit_keys", "runtime_direct_exposures"]) {
      expect(DEV_RESET_PRESERVED_TABLES).toContain(table);
    }
  });
});

describe("assertDevResetAllowed", () => {
  const local = "postgres://owner:secret@127.0.0.1:5432/openedbot";

  test("accepte development sur la boucle locale", () => {
    expect(() => assertDevResetAllowed({ environment: "development", databaseUrl: local })).not.toThrow();
    expect(() =>
      assertDevResetAllowed({ environment: "development", databaseUrl: "postgres://o:s@localhost:5432/openedbot" }),
    ).not.toThrow();
  });

  test("refuse hors development, quelle que soit la base", () => {
    for (const environment of ["test", "production", "preprod"]) {
      expect(() => assertDevResetAllowed({ environment, databaseUrl: local })).toThrow(/hors development/);
    }
  });

  test("refuse une base distante, même nommée comme la locale", () => {
    expect(() =>
      assertDevResetAllowed({ environment: "development", databaseUrl: "postgres://o:s@db.preprod.openedbot:5432/openedbot" }),
    ).toThrow(/hors base locale/);
  });

  test("refuse une base système ou un nom non citable", () => {
    expect(() =>
      assertDevResetAllowed({ environment: "development", databaseUrl: "postgres://o:s@127.0.0.1:5432/postgres" }),
    ).toThrow(/base système/);
    expect(() =>
      assertDevResetAllowed({ environment: "development", databaseUrl: "postgres://o:s@127.0.0.1:5432/openedbot%22;%20drop" }),
    ).toThrow(/nom de base/);
  });
});

describe("resolveDevResetTables", () => {
  test("dérive la liste du schéma réel et exclut les préservées par binding", async () => {
    const recorder = { statements: [] as string[], unsafe: [] as string[] };
    const sql = fakeSql([[{ name: "bots" }, { name: "runs" }]], recorder);
    expect(await resolveDevResetTables(sql)).toEqual(["bots", "runs"]);
    expect(recorder.statements[0]).toContain("information_schema.tables");
    expect(recorder.statements[0]).toContain("table_type = 'BASE TABLE'");
    expect(recorder.statements[0]).toContain("table_name <> all(");
  });

  test("refuse une table au nom non citable plutôt que de l'interpoler", async () => {
    const recorder = { statements: [] as string[], unsafe: [] as string[] };
    const sql = fakeSql([[{ name: 'bots"; drop table users; --' }]], recorder);
    expect(resolveDevResetTables(sql)).rejects.toThrow(/non citable/);
  });
});

describe("performDevDataReset", () => {
  test("truncate la liste dérivée, puis remet les drapeaux d'accueil à zéro", async () => {
    const recorder = { statements: [] as string[], unsafe: [] as string[] };
    // 1: derived tables, 2: cascade check (empty), 3: organizations, 4: people.
    const sql = fakeSql([[{ name: "bots" }, { name: "runs" }], [], [{ id: "org-1" }], [{ id: "user-1" }]], recorder);
    const report = await performDevDataReset(sql);
    expect(recorder.unsafe).toEqual(['truncate table "bots", "runs" restart identity cascade']);
    expect(recorder.statements.some((s) => s.includes("update organizations set onboarding = null, onboarded_at = null"))).toBe(true);
    expect(recorder.statements.some((s) => s.includes("update users set onboarding_completed = false"))).toBe(true);
    expect(report.truncatedTables).toEqual(["bots", "runs"]);
    expect(report.organizationsReset).toBe(1);
    expect(report.usersReset).toBe(1);
  });

  test("refuse quand une table préservée référence une table vidée : la cascade l'emporterait", async () => {
    const recorder = { statements: [] as string[], unsafe: [] as string[] };
    const sql = fakeSql([[{ name: "bots" }], [{ child: "sessions", parent: "bots" }]], recorder);
    expect(performDevDataReset(sql)).rejects.toThrow(/cascade/);
    expect(recorder.unsafe).toEqual([]);
  });
});
