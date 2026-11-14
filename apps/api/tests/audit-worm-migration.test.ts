import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../../db/migrations/0053_audit_worm.sql", import.meta.url), "utf8");

/** What 0053 must hold: two more kinds on the link journal, the WORM state of each verdict, nothing destructive. */
describe("contrat de la migration 0053_audit_worm", () => {
  test("transactionnelle, enregistrée, additive", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0053_audit_worm')");
    expect(sql).not.toMatch(/drop table|drop column/i);
  });

  test("le journal du lien accepte worm_write_failed et anchor_tampered sans perdre les kinds existants", () => {
    const constraint = sql.slice(sql.indexOf("add constraint runtime_link_events_kind_check"), sql.indexOf("comment on constraint"));
    for (const kind of ["connected", "replaced", "disconnected", "revoked", "rotated", "hijack_suspected", "pop_failed", "pop_missing", "unattributed_session", "clock_skew", "worm_write_failed", "anchor_tampered"]) {
      expect(constraint).toContain(`'${kind}'`);
    }
  });

  test("chaque verdict porte son état WORM, disabled par défaut pour les lignes antérieures", () => {
    expect(sql).toContain("add column worm_state text not null default 'disabled'");
    expect(sql).toContain("check (worm_state in ('disabled', 'missing', 'matches', 'tampered'))");
  });
});
