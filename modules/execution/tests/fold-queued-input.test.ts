import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { foldQueuedRunInputTx } from "../src/application/run-columns";

/** A tagged-template stand-in: answers the locking read, records the write. */
function fakeTx(current: string | null) {
  const writes: unknown[][] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("select input from runs")) {
      expect(sql).toContain("for update");
      return Promise.resolve(current === null ? [] : [{ input: current }]);
    }
    writes.push(values);
    return Promise.resolve([]);
  }) as unknown as SQL;
  return { tx, writes };
}

const run = { organizationId: "org", id: "run-queued" };

describe("message folded into a queued run", () => {
  test("numbers the burst instead of gluing it with a blank line", async () => {
    const { tx, writes } = fakeTx("et au havre ?");
    await foldQueuedRunInputTx(tx, run, "test");
    expect(writes[0]![0]).toBe(
      "[2 messages sent in a row by the user — answer all of them together]\n1. et au havre ?\n2. test",
    );
  });

  test("a third message extends the numbering of an already merged input", async () => {
    const { tx, writes } = fakeTx(
      "[2 messages sent in a row by the user — answer all of them together]\n1. et au havre ?\n2. test",
    );
    await foldQueuedRunInputTx(tx, run, "et à Rouen ?");
    expect(writes[0]![0]).toBe(
      "[3 messages sent in a row by the user — answer all of them together]\n1. et au havre ?\n2. test\n3. et à Rouen ?",
    );
  });

  test("a run claimed in the meantime is left untouched", async () => {
    const { tx, writes } = fakeTx(null);
    await foldQueuedRunInputTx(tx, run, "test");
    expect(writes).toHaveLength(0);
  });
});
