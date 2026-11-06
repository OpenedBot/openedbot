import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { captureRunEventTx, captureSteeringReceiptTx, withRunReceiptJournalTx } from "../src/application/run-receipts";

type Query = { sql: string; values: unknown[] };

function journalTransaction() {
  const queries: Query[] = [];
  const tx = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!("raw" in strings)) return strings;
    const sql = strings.join("?");
    queries.push({ sql, values });
    if (sql.includes("from run_steering_attempts steer")) {
      const organizationId = String(values[0]);
      return Promise.resolve([{ runId: `source-${organizationId}`, threadId: "thread", payload: { status: "confirmed" } }]);
    }
    if (sql.includes("insert into run_events")) {
      return Promise.resolve([{ cursor: "1", botId: null, turnId: null, sessionKey: null, leaseGeneration: "0", occurredAt: new Date() }]);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  return { tx, queries };
}

describe("durable run receipt journal", () => {
  test("finishes business locks and every source key before allocating any organization cursor", async () => {
    const { tx, queries } = journalTransaction();
    const result = await withRunReceiptJournalTx(tx, async (transaction) => {
      captureSteeringReceiptTx(transaction, "org-b", "attempt-b");
      captureSteeringReceiptTx(transaction, "org-a", "attempt-a");
      captureRunEventTx(transaction, {
        organizationId: "org-c", runId: "expired-c", threadId: "thread", type: "run.error",
        payload: { errorCode: "WORKFLOW_DEADLINE_EXCEEDED" },
      });
      await transaction`select 'last-business-lock'`;
      expect(queries.some((query) => query.sql.includes("insert into run_events"))).toBe(false);
      return "claimed";
    });
    expect(result).toBe("claimed");
    const at = (fragment: string) => queries.map((query, index) => query.sql.includes(fragment) ? index : -1).filter((index) => index >= 0);
    const parents = at("for no key update");
    const cursors = at("pg_advisory_xact_lock");
    const sequences = at("max(sequence)");
    expect(parents).toHaveLength(3);
    expect(cursors).toHaveLength(3);
    // Every run row, then every cursor, then the sequences (S2c), each in its own statement.
    expect(Math.max(...parents)).toBeLessThan(Math.min(...cursors));
    expect(Math.max(...cursors)).toBeLessThan(Math.min(...sequences));
    expect(queries[cursors[0]!]!.values[0]).toBe("org-a");
    expect(queries[cursors[2]!]!.values[0]).toBe("org-c");
    expect(queries.filter((query) => query.sql.includes("insert into run_events"))).toHaveLength(3);
  });

  test("a failed business operation discards its batch and does not contaminate a reused transaction object", async () => {
    const { tx, queries } = journalTransaction();
    await expect(withRunReceiptJournalTx(tx, async (transaction) => {
      captureSteeringReceiptTx(transaction, "org-a", "attempt-a");
      throw new Error("business operation failed");
    })).rejects.toThrow("business operation failed");
    await withRunReceiptJournalTx(tx, async () => "no change");
    expect(queries).toHaveLength(0);
    expect(() => captureSteeringReceiptTx(tx, "org-a", "attempt-a")).toThrow("journal transaction");
  });

  test("nested work shares the outer batch and repeated captures produce one final-state receipt", async () => {
    const { tx, queries } = journalTransaction();
    await withRunReceiptJournalTx(tx, async (transaction) => {
      captureSteeringReceiptTx(transaction, "org-a", "attempt-a");
      await withRunReceiptJournalTx(transaction, async (nested) => {
        captureSteeringReceiptTx(nested, "org-a", "attempt-a");
      });
      expect(queries).toHaveLength(0);
    });
    expect(queries.filter((query) => query.sql.includes("insert into run_events"))).toHaveLength(1);
  });
});
