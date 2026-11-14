import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration 0154 : le worker ne lit plus l'audit de toutes les organisations.
 * Ni policy ni SELECT sur `audit_chain` et `audit_worm_orphans` ; la purge
 * lit la chaîne via `audit_chain_for_purge(org)`, EXECUTE pour openedbot_worker
 * seul. La preuve sur base réelle (propriétaire, ACL, NULL, org A/B) est dans
 * `tests/integration/audit-chain-for-purge.sql`.
 */
const root = join(import.meta.dir, "../../..");
const sql = readFileSync(join(root, "db/migrations/0154_audit_worker_least_privilege.sql"), "utf8");
const statements = sql
  .replace(/--[^\n]*/g, "")
  .split(";")
  .map((statement) => statement.replace(/\s+/g, " ").trim().toLowerCase());
const fn = "public.audit_chain_for_purge(uuid)";

describe("migration 0154", () => {
  test("retire la policy et tout privilège worker sur les deux tables", () => {
    expect(statements).toContain("drop policy if exists audit_chain_worker on audit_chain");
    expect(statements).toContain("revoke all on audit_chain from openedbot_worker");
    expect(statements).toContain("drop policy if exists audit_worm_orphans_worker on audit_worm_orphans");
    expect(statements).toContain("revoke all on audit_worm_orphans from openedbot_worker");
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant\s[^;]*\bon\s+(table\s+)?(public\.)?audit_(chain|worm_orphans)\b/i);
  });

  test("fonction SECURITY DEFINER, STABLE, search_path figé, propriétaire = rôle de migration", () => {
    expect(sql).toMatch(/create function public\.audit_chain_for_purge\(org uuid\)/);
    expect(sql).toMatch(/\bsecurity definer\b/);
    expect(sql).toMatch(/\bstable\b/);
    expect(sql).toContain("set search_path = pg_catalog, pg_temp");
    expect(sql).toContain("from public.audit_chain c");
    expect(sql).toContain("where c.organization_id = org");
    expect(sql).toMatch(/if org is null then\s+raise exception[^;]*errcode = '22004'/);
    // Owner = the owner of audit_chain (the migration role), never an application role.
    expect(sql).toContain("alter function public.audit_chain_for_purge(uuid) owner to %I', migrator");
    expect(sql).toContain("where t.schemaname = 'public' and t.tablename = 'audit_chain'");
    expect(sql).toContain("if migrator in ('openedbot_api', 'openedbot_worker', 'openedbot_staff') then");
    expect(sql).not.toMatch(/owner to openedbot_(api|worker|staff)\b/);
  });

  test("EXECUTE : révoqué à PUBLIC, accordé à openedbot_worker seul", () => {
    expect(statements).toContain(`revoke all on function ${fn} from public`);
    const grants = statements.filter((statement) => statement.startsWith("grant "));
    expect(grants).toEqual([`grant execute on function ${fn} to openedbot_worker`]);
    const revoke = statements.indexOf(`revoke all on function ${fn} from public`);
    expect(revoke).toBeLessThan(statements.indexOf(grants[0]!));
  });

  test("ne rend que les colonnes copiées par l'archive de purge", () => {
    const columns = sql.match(/returns table \(([^)]*)\)/)?.[1]?.split(",").map((column) => column.trim().split(/\s+/)[0]);
    expect(columns).toEqual([
      "organization_id", "runtime_id", "seq", "kind", "object_key", "payload",
      "payload_sha256", "prev_hash", "hash", "created_at",
    ]);
  });

  test("enregistrée", () => {
    expect(sql).toContain("('0154_audit_worker_least_privilege')");
  });
});
