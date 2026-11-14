import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../../db/migrations/0040_api_instances.sql", import.meta.url), "utf8");

describe("contrat de la migration 0040_api_instances", () => {
  test("transactionnelle et enregistrée dans schema_migrations", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("insert into schema_migrations(version) values ('0040_api_instances')");
    expect(sql).toContain("on conflict (version) do nothing");
  });

  test("table d'exploitation hors RLS, grants lecture worker et écriture API", () => {
    expect(sql).toContain("create table api_instances (");
    expect(sql).toContain("instance_id text primary key");
    expect(sql).toContain("internal_url text not null");
    expect(sql).toContain("started_at timestamptz not null");
    expect(sql).toContain("last_seen_at timestamptz not null");
    expect(sql).toContain("stopped_at timestamptz");
    expect(sql).not.toContain("enable row level security");
    expect(sql).not.toContain("force row level security");
    expect(sql).toContain("grant select, insert, update, delete on api_instances to openedbot_api;");
    expect(sql).toContain("grant select on api_instances to openedbot_worker;");
    expect(sql).not.toMatch(/grant\s+(select,\s*)?insert on api_instances to openedbot_worker/);
  });

  test("fonction runtime_link_owner en security definer, sans donnée d'organisation", () => {
    expect(sql).toContain("create function runtime_link_owner(p_runtime_id uuid)");
    expect(sql).toContain("security definer");
    expect(sql).toContain("interval '60 seconds'");
    expect(sql).toContain("grant execute on function runtime_link_owner(uuid) to openedbot_api;");
    expect(sql).toContain("grant execute on function runtime_link_owner(uuid) to openedbot_worker;");
    expect(sql).toContain("revoke all on function runtime_link_owner(uuid) from public;");
    const fn = sql.slice(sql.indexOf("create function runtime_link_owner"), sql.indexOf("comment on function runtime_link_owner"));
    expect(fn).not.toContain("organization_id");
  });
});
