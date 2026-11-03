import { describe, expect, test } from "bun:test";
import type { TransactionDb } from "@openedbot/platform-db";
import { readRosterBots } from "../src/sql/bots";
import { readGroups } from "../src/sql/groups";

function capture() {
  const statements: string[] = [];
  const tx = ((strings: TemplateStringsArray) => {
    statements.push([...strings].join(" ? ").replace(/\s+/gu, " "));
    return Promise.resolve([]);
  }) as unknown as TransactionDb;
  return { tx, statements };
}

// PERM2-7: a gate under automatic review waits on no human, so it lights no
// « awaiting approval » badge in the roster.
describe("awaitingApproval ignores a gate under automatic review", () => {
  test("bot rows", async () => {
    const { tx, statements } = capture();
    await readRosterBots(tx, "org-1", "user-1", true);
    const sql = statements.find((statement) => statement.includes('as "awaitingApproval"'));
    expect(sql).toContain("and a.decision_state is distinct from 'reviewing' ) as \"awaitingApproval\"");
  });

  test("group rows", async () => {
    const { tx, statements } = capture();
    await readGroups(tx, "org-1");
    const sql = statements.find((statement) => statement.includes('as "awaitingApproval"'));
    expect(sql).toContain("and a.decision_state is distinct from 'reviewing') as \"awaitingApproval\"");
  });
});

// A run left `unknown` + `ambiguous` (« À vérifier ») waits on a human: the
// roster must not show « Réflexion en cours… » for it forever.
describe("running ignores a run waiting for review", () => {
  test("bot rows", async () => {
    const { tx, statements } = capture();
    await readRosterBots(tx, "org-1", "user-1", true);
    const sql = statements.find((statement) => statement.includes(") as running,"));
    expect(sql).toContain("and not (active_run.status = 'unknown' and active_run.external_state = 'ambiguous') ) as running,");
  });
});
