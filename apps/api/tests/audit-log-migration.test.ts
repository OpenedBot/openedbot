import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../../db/migrations/0035_audit_log.sql", import.meta.url), "utf8");

/**
 * Corps de la vue : de `create view audit_log` jusqu'au `comment on view` qui
 * la suit. On en retire les commentaires SQL de fin de ligne : ce qui est
 * interdit, c'est de PROJETER une colonne sensible, pas de la nommer dans le
 * commentaire qui explique pourquoi elle est exclue.
 */
function viewBody(): string {
  const start = sql.indexOf("create view audit_log");
  const end = sql.indexOf("comment on view audit_log");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql
    .slice(start, end)
    .split("\n")
    .map((line) => line.replace(/--.*$/u, ""))
    .join("\n");
}

describe("contrat de la migration 0035_audit_log", () => {
  test("la migration est transactionnelle et s'enregistre dans schema_migrations", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0035_audit_log')");
    expect(sql).toContain("on conflict (version) do nothing");
  });

  test("la vue couvre les quatre journaux existants, sans en recopier aucun", () => {
    const body = viewBody();

    for (const relation of [
      "public.staff_impersonation_claims",
      "public.runtime_link_events",
      "public.decisions",
      "public.webhook_management_operations",
    ]) {
      expect(body).toContain(relation);
    }

    for (const source of [
      "'staff_impersonation'::text",
      "'runtime_link'::text",
      "'decision'::text",
      "'webhook_management'::text",
    ]) {
      expect(body).toContain(source);
    }

    // Trois `union all` pour quatre branches.
    expect(body.match(/union all/gu)?.length).toBe(3);

    // Une vue, pas une table : aucune duplication des événements.
    expect(sql).not.toMatch(/create table\s+audit_log/u);
    expect(sql).not.toMatch(/insert into\s+(public\.)?audit_log/u);
  });

  test("la vue est posée en security_invoker pour hériter de la RLS des tables sources", () => {
    expect(sql).toMatch(/create view audit_log\s*\n?\s*with \(security_invoker = true\)/u);
    expect(sql).not.toContain("security_barrier");
  });

  test("aucune colonne sensible n'apparaît dans la projection de la vue", () => {
    const body = viewBody();

    for (const forbidden of ["email", "token", "password", "hash", "claim_code", "content"]) {
      expect({ forbidden, found: new RegExp(forbidden, "iu").test(body) }).toEqual({
        forbidden,
        found: false,
      });
    }

    // Les colonnes précises que chaque source porte et que la vue doit taire.
    for (const column of [
      "claim_token_hash",
      "envelope",
      "previous_hash",
      "entry_hash",
      "request_hash",
      "secret_ciphertext",
      "secret_nonce",
      "secret_tag",
      "secret_key_id",
    ]) {
      expect({ column, found: body.includes(column) }).toEqual({ column, found: false });
    }
  });

  test("la vue est normalisée sur les neuf colonnes du contrat", () => {
    const body = viewBody();
    for (const column of [
      "as occurred_at",
      "as organization_id",
      "as source",
      "as action",
      "as actor_kind",
      "as actor_id",
      "as subject_kind",
      "as subject_id",
      "as details",
    ]) {
      expect(body).toContain(column);
    }
  });

  test("la fonction staff porte le préambule de garde de staff_operational_metrics", () => {
    expect(sql).toContain("create or replace function staff_audit_log(");
    expect(sql).toContain("p_limit int default 200");
    expect(sql).toContain("p_before timestamptz default null");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = pg_catalog, public");
    expect(sql).toContain("nullif(current_setting('app.staff_user_id', true), '')::uuid");
    expect(sql).toContain("when invalid_text_representation then");
    expect(sql).toContain("raise exception 'staff authentication required' using errcode = '42501'");
    expect(sql).toContain("raise exception 'staff user disabled' using errcode = '42501'");
  });

  test("la fonction rend les lignes les plus récentes d'abord, paginées par p_before", () => {
    expect(sql).toContain("from public.audit_log a");
    expect(sql).toContain("where p_before is null or a.occurred_at < p_before");
    expect(sql).toContain("order by a.occurred_at desc");
    expect(sql).toMatch(/limit greatest\(1, least\(coalesce\(p_limit, 200\), 1000\)\)/u);
  });

  test("les droits sont fermés puis rouverts au seul rôle API", () => {
    expect(sql).toContain("revoke all on function staff_audit_log(int, timestamptz) from public;");
    expect(sql).toContain("grant execute on function staff_audit_log(int, timestamptz) to ohb_api;");
    expect(sql).toContain("grant select on audit_log to ohb_api;");
    // Le journal est en lecture seule : aucun droit d'écriture sur la vue.
    expect(sql).not.toMatch(/grant[^;]*\b(insert|update|delete)\b[^;]*on audit_log/u);
  });

  test("le commentaire de la vue dit qui lit et pose la rétention longue", () => {
    const comment = sql.slice(
      sql.indexOf("comment on view audit_log"),
      sql.indexOf("grant select on audit_log"),
    );
    expect(comment).toContain("ADMINS DU TENANT");
    expect(comment).toContain("STAFF");
    expect(comment).toMatch(/au moins un an/u);
    expect(comment).toMatch(/90 jours/u);
  });
});
