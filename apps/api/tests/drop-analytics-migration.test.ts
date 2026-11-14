import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("drop analytics migration contract", () => {
  test("0107 rewrites staff_get_user without analytics_events before dropping the function and the three tables", () => {
    const sql = readFileSync(new URL("../../../db/migrations/0107_drop_analytics.sql", import.meta.url), "utf8");

    expect(sql).toContain("drop function if exists staff_analytics_timeseries(date, date)");

    for (const table of ["analytics_daily_global", "analytics_daily", "analytics_events"]) {
      expect(sql).toContain(`drop table if exists ${table};`);
    }

    expect(sql).toContain("insert into schema_migrations(version) values ('0107_drop_analytics')");

    // The rewritten function no longer reads the dropped fact table.
    const rewrite = sql.indexOf("create or replace function staff_get_user(p_id uuid)");
    const rewritten = sql.slice(rewrite, sql.indexOf("revoke all on function staff_get_user(uuid) from public;"));
    expect(rewritten).toContain("'organizationActivity'");
    expect(rewritten).not.toContain("analytics");

    const factDrop = sql.indexOf("drop table if exists analytics_events");
    expect(rewrite).toBeGreaterThanOrEqual(0);
    expect(factDrop).toBeGreaterThan(rewrite);
  });
});
