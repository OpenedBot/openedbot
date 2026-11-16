import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TransactionSQL } from "bun";
import { eraseAccountUser } from "../src/sql/deletions";

const functions = readFileSync(new URL("../../../db/migrations/0002_functions.sql", import.meta.url), "utf8");
const grants = readFileSync(new URL("../../../db/migrations/0009_grants.sql", import.meta.url), "utf8");
const fn = functions.slice(functions.indexOf("CREATE FUNCTION public.erase_account_user"), functions.indexOf("$$;", functions.indexOf("CREATE FUNCTION public.erase_account_user")));

function capturing(outcome: unknown) {
  const captured: string[] = [];
  const tx = ((strings: TemplateStringsArray) => {
    captured.push([...strings].join("?").replace(/\s+/g, " ").trim());
    return Promise.resolve(outcome === undefined ? [] : [{ outcome }]);
  }) as unknown as TransactionSQL;
  return { tx, captured };
}

describe("effacement du compte après la purge", () => {
  test("le worker appelle la fonction et rend son verdict", async () => {
    const { tx, captured } = capturing("pseudonymized");
    expect(await eraseAccountUser(tx, "10000000-0000-4000-8000-000000000001")).toBe("pseudonymized");
    expect(captured).toEqual(["select public.erase_account_user(?::uuid) as outcome"]);
  });

  test("un verdict inconnu fait échouer la purge plutôt que de la dire faite", async () => {
    await expect(eraseAccountUser(capturing(undefined).tx, "u")).rejects.toThrow(/Unexpected/);
  });

  test("une adhésion révoquée ne bloque plus l'effacement : le compte est pseudonymisé", () => {
    // Même règle que l'éligibilité : seule une adhésion vivante garde le compte.
    expect(fn).toContain("select 1 from public.memberships where user_id = p_user_id and revoked_at is null)");
    expect(fn).toContain("password_hash = null");
    expect(fn).toContain("google_subject = null");
    expect(fn).toContain("delete from public.sessions where user_id = p_user_id");
    // Les adhésions révoquées et l'historique des autres tenants restent.
    expect(fn).not.toMatch(/delete from public\.memberships/);
    expect(grants).toContain("GRANT ALL ON FUNCTION public.erase_account_user(p_user_id uuid) TO openedbot_worker;");
  });
});
