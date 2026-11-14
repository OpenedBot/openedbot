import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../../db/migrations/0037_tool_errors.sql", import.meta.url), "utf8");

describe("contrat de la migration 0037_tool_errors", () => {
  test("transactionnelle et enregistrée dans schema_migrations", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0037_tool_errors')");
  });

  test("RLS tenant forcée pour openedbot_api, ouverte pour le worker qui écrit hors tenant", () => {
    expect(sql).toContain("alter table tool_errors enable row level security;");
    expect(sql).toContain("alter table tool_errors force row level security;");
    expect(sql).toContain("create policy tool_errors_tenant on tool_errors to openedbot_api");
    expect(sql).toContain("nullif(current_setting('app.organization_id', true), '')::uuid");
    expect(sql).toContain("create policy tool_errors_worker on tool_errors to openedbot_worker");
  });

  test("la purge d'un bot emporte ses lignes ; l'opérateur est nullable et détaché à son départ", () => {
    expect(sql).toContain("references bots(organization_id, id) on delete cascade");
    expect(sql).toContain("references runs(organization_id, id) on delete cascade");
    expect(sql).toContain("references memberships(organization_id, user_id) on delete set null (user_id)");
    expect(sql).toMatch(/user_id\s+uuid,/);
  });

  test("le message est borné à 500 et la lecture par bot est indexée", () => {
    expect(sql).toContain("length(error_message) <= 500");
    expect(sql).toContain("on tool_errors (organization_id, bot_id, occurred_at desc, id desc)");
  });
});
