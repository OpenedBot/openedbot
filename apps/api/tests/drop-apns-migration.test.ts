import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("drop APNs migration contract", () => {
  test("0012 cuts the live enqueue trigger, then drops the four APNs tables, and leaves the workflow sequence", () => {
    const sql = readFileSync(new URL("../../../db/migrations/0012_drop_apns.sql", import.meta.url), "utf8");

    expect(sql).toContain("drop trigger if exists workflows_apns_notification");
    expect(sql).toContain("drop function if exists enqueue_autonomous_workflow_notification()");

    for (const table of [
      "apns_notification_deliveries",
      "apns_live_activity_registrations",
      "apns_notification_outbox",
      "apns_device_registrations",
    ]) {
      expect(sql).toContain(`drop table if exists ${table}`);
    }

    expect(sql).toContain("insert into schema_migrations(version) values ('0012_drop_apns')");

    expect(sql).not.toMatch(/drop (?:trigger|function)(?: if exists)? (?:advance_workflow_notification_sequence|workflows_notification_sequence)/u);

    const triggerDrop = sql.indexOf("drop trigger if exists workflows_apns_notification");
    const outboxDrop = sql.indexOf("drop table if exists apns_notification_outbox");
    expect(triggerDrop).toBeGreaterThanOrEqual(0);
    expect(outboxDrop).toBeGreaterThan(triggerDrop);
  });
});
