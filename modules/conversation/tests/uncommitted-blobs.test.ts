import { describe, expect, test } from "bun:test";
import type { SQL, TransactionSQL } from "bun";
import {
  UNCOMMITTED_BLOB_GRACE_SECONDS,
  claimReservedBlobsTx,
  reserveUncommittedBlobs,
} from "../src/sql/uncommitted-blobs";

const ORG = "10000000-0000-4000-8000-000000000001";
const KEY = `org/${ORG}/10000000-0000-4000-8000-0000000000aa`;

function fakeDb(answer: (sql: string, values: unknown[]) => unknown[]) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ sql, values });
    return Promise.resolve(answer(sql, values));
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return { tx, statements };
}

describe("octets d'un envoi sans Idempotency-Key", () => {
  test("les clés entrent dans la file durable avec un délai, sous le tenant", async () => {
    const { tx, statements } = fakeDb(() => []);
    await reserveUncommittedBlobs(tx, ORG, [KEY], "r2");
    expect(statements[0]!.sql).toStartWith("select set_config('app.organization_id'");
    const insert = statements.find((row) => row.sql.startsWith("insert into tenant_blob_deletions"));
    expect(insert?.values).toEqual([KEY, ORG, "r2", UNCOMMITTED_BLOB_GRACE_SECONDS]);
  });

  test("aucune pièce jointe : aucune transaction", async () => {
    const { tx, statements } = fakeDb(() => []);
    await reserveUncommittedBlobs(tx, ORG, [], "file");
    expect(statements).toEqual([]);
  });

  test("le commit retire la réservation de chaque objet référencé", async () => {
    const { tx, statements } = fakeDb((_sql, values) => [{ key: values[0] }]);
    await claimReservedBlobsTx(tx as unknown as TransactionSQL, ORG, [KEY]);
    expect(statements[0]!.sql).toStartWith("delete from tenant_blob_deletions");
    expect(statements[0]!.sql).toContain("lease_owner is null");
  });

  test("une réservation déjà drainée interdit le commit de la pièce jointe", async () => {
    const { tx } = fakeDb(() => []);
    await expect(claimReservedBlobsTx(tx as unknown as TransactionSQL, ORG, [KEY])).rejects.toThrow(/reservation is missing/);
  });
});
