import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { purgeDeadSessions, purgeSpentEmailLoginCodes } from "../src/sql/auth-retention";

function capturingDb(count: string | number) {
  const captured = { sql: "", bound: [] as unknown[] };
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.sql = [...strings].join(" ");
    captured.bound = values;
    return Promise.resolve([{ count }]);
  }) as unknown as Bun.SQL;
  return { db, captured };
}

const migration = readFileSync(new URL("../../../db/migrations/0169_worker_retention_purges.sql", import.meta.url), "utf8");

describe("purges des données de connexion", () => {
  test("le worker n'envoie aucune borne : il appelle la fonction et rend son compte", async () => {
    const codes = capturingDb("3");
    expect(await purgeSpentEmailLoginCodes(codes.db)).toBe(3);
    expect(codes.captured.sql).toBe("select public.purge_spent_email_login_codes() as count");
    expect(codes.captured.bound).toEqual([]);

    const sessions = capturingDb(2);
    expect(await purgeDeadSessions(sessions.db)).toBe(2);
    expect(sessions.captured.sql).toBe("select public.purge_dead_sessions() as count");
    expect(sessions.captured.bound).toEqual([]);
  });

  test("la migration porte les délais publiés et n'ouvre que l'EXECUTE au worker", () => {
    expect(migration).toContain("expires_at < pg_catalog.now() - interval '1 day'");
    expect(migration).toContain("coalesce(refresh_expires_at, access_expires_at) < pg_catalog.now() - interval '30 days'");
    expect(migration).toContain("revoked_at is null or revoked_at < pg_catalog.now() - interval '30 days'");
    expect(migration).toMatch(/grant execute on function public\.purge_dead_sessions\(\) to ohb_worker;/);
    expect(migration).toMatch(/grant execute on function public\.purge_spent_email_login_codes\(\) to ohb_worker;/);
    expect(migration).not.toMatch(/grant [^;]* on (table )?(sessions|email_login_codes)\b/);
    expect(migration).not.toMatch(/create policy/);
  });
});
