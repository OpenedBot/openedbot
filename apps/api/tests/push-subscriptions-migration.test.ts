import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("0039 push subscriptions migration", () => {
  const sql = readFileSync(new URL("../../../db/migrations/0039_push_subscriptions.sql", import.meta.url), "utf8");

  test("crée les trois tables, RLS tenant, grants api et worker", () => {
    for (const table of ["push_subscriptions", "push_outbox", "push_deliveries"]) {
      expect(sql).toContain(`create table ${table}`);
      expect(sql).toContain(`alter table ${table} enable row level security`);
      expect(sql).toContain(`alter table ${table} force row level security`);
    }
    expect(sql).toContain("grant select, insert, update, delete on push_subscriptions to ohb_api");
    expect(sql).toContain("grant select, insert, update, delete on push_subscriptions to ohb_worker");
    expect(sql).toContain("grant select, insert, update, delete on push_outbox to ohb_worker");
    expect(sql).toContain("grant select, insert, update, delete on push_deliveries to ohb_worker");
    expect(sql).toContain("references organizations(id) on delete cascade");
    expect(sql).toContain("references memberships(organization_id, user_id) on delete cascade");
    expect(sql).toContain("unique (workflow_id, notification_sequence, subscription_id)");
    expect(sql).toContain("insert into schema_migrations(version) values ('0039_push_subscriptions')");
  });

  test("n'écrit aucun contenu de message dans l'outbox", () => {
    expect(sql).not.toMatch(/final_output|error_message|prompt/u);
    expect(sql).toContain("bot_name");
    expect(sql).toContain("event_type");
  });
});
