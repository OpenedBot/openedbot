import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../../db/migrations/0038_routine_missed.sql", import.meta.url), "utf8");

describe("contrat de la migration 0038_routine_missed", () => {
  test("transactionnelle et enregistrée dans schema_migrations", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0038_routine_missed')");
  });

  test("ajoute missed_count, last_missed_at et busy_retries bornés", () => {
    expect(sql).toContain("add column missed_count integer not null default 0");
    expect(sql).toContain("add column last_missed_at timestamptz");
    expect(sql).toContain("add column busy_retries integer not null default 0");
    expect(sql).toContain("routines_missed_count_nonneg");
    expect(sql).toContain("routines_busy_retries_nonneg");
  });
});
