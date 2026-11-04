import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { purgeClosedSupportConversations } from "../src/sql/support-retention";

function capture(): { db: SQL; statements: string[] } {
  const statements: string[] = [];
  const db = ((strings: TemplateStringsArray) => {
    statements.push(strings.join("?").replace(/\s+/g, " ").trim());
    return Promise.resolve([{ count: 1 }]);
  }) as unknown as SQL;
  return { db, statements };
}

describe("rétention des fils de support fermés", () => {
  test("les candidats sont verrouillés et seuls eux nourrissent le manifeste et le DELETE", async () => {
    const { db, statements } = capture();
    expect(await purgeClosedSupportConversations(db, 180, new Date("2026-11-04T00:00:00Z"))).toBe(1);
    const sql = statements[0]!;
    const doomed = sql.slice(sql.indexOf("with doomed as"), sql.indexOf("), queued as"));
    // Un fil en cours de réouverture est sauté, jamais attendu puis supprimé.
    expect(doomed).toContain("for update skip locked");
    expect(sql).toContain("join doomed d on d.id = a.conversation_id");
    expect(sql).toContain("using doomed d where c.id = d.id and c.status = 'closed'");
  });
});
