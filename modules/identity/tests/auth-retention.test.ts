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

const functions = readFileSync(new URL("../../../db/migrations/0002_functions.sql", import.meta.url), "utf8");
const grants = readFileSync(new URL("../../../db/migrations/0009_grants.sql", import.meta.url), "utf8");

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

  test("les fonctions portent les délais publiés et le worker n'a que l'EXECUTE", () => {
    expect(functions).toContain("expires_at < pg_catalog.now() - interval '1 day'");
    expect(functions).toContain("coalesce(refresh_expires_at, access_expires_at) < pg_catalog.now() - interval '30 days'");
    expect(functions).toContain("revoked_at is null or revoked_at < pg_catalog.now() - interval '30 days'");
    expect(grants).toContain("GRANT ALL ON FUNCTION public.purge_dead_sessions() TO openedbot_worker;");
    expect(grants).toContain("GRANT ALL ON FUNCTION public.purge_spent_email_login_codes() TO openedbot_worker;");
    expect(grants).not.toMatch(/ON TABLE public\.(sessions|email_login_codes) TO openedbot_worker/);
  });
});
