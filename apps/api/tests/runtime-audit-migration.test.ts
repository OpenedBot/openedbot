import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../../db/migrations/0052_runtime_audit.sql", import.meta.url), "utf8");

/** What 0052 must hold: four tables under RLS, two columns, the new kinds, the view with five sources. */
describe("contrat de la migration 0052_runtime_audit", () => {
  test("transactionnelle, enregistrée, additive", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0052_runtime_audit')");
    expect(sql).not.toMatch(/drop table/i);
  });

  test("chaque table nouvelle est sous RLS forcée avec une politique openedbot_api", () => {
    for (const table of ["runtime_audit_keys", "runtime_audit_anchors", "runtime_link_dispatches", "runtime_audit_verifications"]) {
      expect(sql).toContain(`create table ${table} (`);
      expect(sql).toContain(`alter table ${table} enable row level security;`);
      expect(sql).toContain(`alter table ${table} force row level security;`);
      expect(sql).toMatch(new RegExp(`create policy \\w+ on ${table} to openedbot_api`));
    }
  });

  test("les clés d'audit portent le quadruplet chiffré du keyring, une seule courante par runtime", () => {
    expect(sql).toContain("key_encryption_key_id text not null");
    expect(sql).toContain("create unique index runtime_audit_keys_current_idx on runtime_audit_keys (runtime_id) where retired_at is null");
  });

  test("les verdicts sont idempotents par export et ne stockent jamais les événements", () => {
    expect(sql).toContain("unique (runtime_id, export_sha256)");
    const table = sql.slice(sql.indexOf("create table runtime_audit_verifications"), sql.indexOf("create index runtime_audit_verifications_recent_idx"));
    expect(table).not.toContain("events");
    expect(table).toContain("findings jsonb not null default '[]'::jsonb");
  });

  test("le lien gagne la clé device, l'échéance du jeton et les kinds de sécurité", () => {
    expect(sql).toContain("add column link_device_pubkey text");
    expect(sql).toContain("add column link_token_expires_at timestamptz");
    for (const kind of ["pop_failed", "pop_missing", "unattributed_session", "clock_skew"]) expect(sql).toContain(`'${kind}'`);
  });

  test("la vue audit_log reste security_invoker et ajoute la cinquième source sans projeter de secret", () => {
    const start = sql.indexOf("create or replace view audit_log");
    const end = sql.indexOf("comment on view audit_log");
    const body = sql.slice(start, end).split("\n").map((line) => line.replace(/--.*$/u, "")).join("\n");
    expect(body).toContain("with (security_invoker = true)");
    for (const relation of ["public.staff_impersonation_claims", "public.runtime_link_events", "public.decisions", "public.webhook_management_operations", "public.runtime_audit_verifications"]) {
      expect(body).toContain(relation);
    }
    expect(body).not.toMatch(/ciphertext|signature|findings/);
  });
});
