import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../../db/migrations/0171_deletion_and_blob_integrity.sql", import.meta.url), "utf8");

describe("contrat de la migration 0171_deletion_and_blob_integrity", () => {
  test("transactionnelle et enregistrée dans schema_migrations", () => {
    expect(sql.trimStart().startsWith("-- ")).toBe(true);
    expect(sql).toContain("\nbegin;\n");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0171_deletion_and_blob_integrity')");
  });

  test("l'API n'inscrit en file que les clés org/ de l'organisation de sa transaction", () => {
    const policy = sql.slice(sql.indexOf("create policy tenant_blob_reservations_api"), sql.indexOf("-- 2."));
    expect(policy).toContain("on tenant_blob_deletions to ohb_api");
    expect(policy.match(/organization_id = nullif\(current_setting\('app\.organization_id', true\), ''\)::uuid/g)).toHaveLength(2);
    expect(policy.match(/object_key like \('org\/' \|\| organization_id::text \|\| '\/%'\)/g)).toHaveLength(2);
  });

  test("la suppression de profil engagée implique l'archivage, que les admissions refusent", () => {
    expect(sql).toContain("alter table bots add column host_profile_deleting_at timestamptz;");
    expect(sql).toContain("check (host_profile_deleting_at is null or archived_at is not null)");
  });

  test("le nettoyage distant d'une publication révoquée a un état durable et reprenable", () => {
    expect(sql).toContain("check (cleanup_status in ('pending', 'done', 'manual'))");
    expect(sql).toContain("where kind = 'managed_cloudflare' and status = 'revoked' and cleanup_status = 'pending'");
  });

  test("un opérateur d'agence sans adhésion cliente peut être l'acteur d'un run, workflow, envoi ou routine", () => {
    for (const [table, column] of [
      ["runs", "initiator_user_id"], ["workflows", "initiator_user_id"],
      ["message_ingress", "user_id"], ["routines", "created_by_user_id"],
    ] as const) {
      expect(sql).toContain(`('${table}', '${column}')`);
      expect(sql).toMatch(new RegExp(`alter table ${table} add constraint \\w+\\s+foreign key \\(${column}\\) references users\\(id\\)`));
    }
    // Seules les FK vers memberships de ces colonnes partent ; aucune FK de ressource.
    expect(sql).toContain("con.confrelid = 'public.memberships'::regclass");
    expect(sql).not.toMatch(/references memberships/);
  });

  test("chaque objet en file de suppression porte le magasin où il a été écrit", () => {
    expect(sql).toContain("alter table tenant_blob_deletions add column driver text");
    expect(sql).toContain("check (driver in ('file', 'r2'))");
  });

  test("la purge d'une agence ne viole plus le CHECK des politiques d'outil de ses clients", () => {
    const section = sql.slice(sql.indexOf("-- 6."), sql.indexOf("insert into schema_migrations"));
    expect(section).toContain("'public.bot_permission_tool_policies'::regclass");
    expect(section).toContain("att.attname = 'updated_by_agency_organization_id'");
    expect(section).toContain("drop constraint %I");
    expect(section).not.toMatch(/drop constraint\s+bot_permission_tool_policies_agency_actor_check/);
  });
});
