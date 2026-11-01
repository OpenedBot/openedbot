import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("thread_compactions migration contract", () => {
  test("0020 pose la table, le watermark, le RLS et élargit step_kind", () => {
    const sql = readFileSync(new URL("../../../db/migrations/0020_thread_compactions.sql", import.meta.url), "utf8");

    expect(sql).toContain("create table thread_compactions");
    expect(sql).toContain("compacted_through_sequence");
    expect(sql).toContain("source_message_count");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("thread_compactions_tenant");
    expect(sql).toContain("thread_compactions_worker");
    expect(sql).toContain("'compaction'");
    expect(sql).toContain("insert into schema_migrations(version) values ('0020_thread_compactions')");
  });
});
