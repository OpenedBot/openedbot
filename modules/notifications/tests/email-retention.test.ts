import { describe, expect, test } from "bun:test";
import { purgeDeliveredEmails } from "../src/sql/email-retention";

describe("purgeDeliveredEmails", () => {
  test("ne supprime que les e-mails partis ou abandonnés depuis plus de 90 jours", async () => {
    let sql = "";
    let bound: unknown[] = [];
    const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      sql = [...strings].join(" ");
      bound = values;
      return Promise.resolve([{ count: "5" }]);
    }) as unknown as Bun.SQL;
    expect(await purgeDeliveredEmails(db, new Date("2026-11-03T12:00:00.000Z"))).toBe(5);
    expect(sql).toContain("delete from email_outbox");
    expect(sql).toContain("status in ('sent', 'failed')");
    expect(sql).toContain("coalesce(sent_at, created_at) <");
    expect(bound).toEqual([new Date("2026-08-05T12:00:00.000Z")]);
  });
});
