// The real Postgres snapshot store, as ohb_api. The route and module tests use
// in-memory stores, so only this proves the SQL: a document round-trips as a
// jsonb object (never a JSON string), only the tenant sees it, and the write
// fence holds: an observation that began before the last invalidation, or
// before the kept document, changes nothing, even for a runtime that had no
// row when it was invalidated.
import { withDisposablePostgres } from "./disposable-postgres";
import { postgresSnapshotStore } from "../../modules/runtimes/src/sql/runtime-read-snapshots";
import type { Db } from "../../platform/db/src/db";

await withDisposablePostgres("ohb122_read_snapshots", async ({ owner: db }) => {
  const organizationId = crypto.randomUUID();
  const otherOrganizationId = crypto.randomUUID();
  const runtimeId = crypto.randomUUID();
  const rollback = new Error("ROLLBACK_SNAPSHOT_FIXTURES");
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 21, 22, 0, seconds));
  const document = { available: true, servers: [{ name: "docs", enabled: true }], error: null };
  try {
    await db.begin(async (tx) => {
      await tx`insert into organizations (id, slug, name) values
        (${organizationId}, ${`snapshot-${organizationId}`}, 'Snapshot fixture'),
        (${otherOrganizationId}, ${`snapshot-${otherOrganizationId}`}, 'Other snapshot fixture')`;
      await tx`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active)
        values (${runtimeId}, ${organizationId}, 'Snapshot fixture', 'connector', 'snapshot-fixture-hash', false)`;
      await tx`set local role ohb_api`;
      const scopedDb = { begin: (callback: (transaction: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as Db;
      const store = postgresSnapshotStore(scopedDb);
      const documentOf = async (kind: "mcp" | "models") => (await store.read(organizationId, runtimeId, kind))?.document ?? null;

      await store.write(organizationId, runtimeId, "mcp", document, at(10));
      const read = await store.read(organizationId, runtimeId, "mcp");
      assert(Bun.deepEquals(read?.document, document), `the snapshot did not round-trip as an object: ${JSON.stringify(read?.document)}`);
      assert(read?.observedAt.getTime() === at(10).getTime(), "observedAt is not the observation start");
      const [type] = await tx<Array<{ type: string }>>`select jsonb_typeof(document) as type from runtime_read_snapshots where runtime_id = ${runtimeId} and kind = 'mcp'`;
      assert(type?.type === "object", `the document is stored as jsonb ${type?.type}, not an object`);

      await store.write(organizationId, runtimeId, "mcp", { older: true }, at(5));
      assert(Bun.deepEquals(await documentOf("mcp"), document), "an older observation overwrote a newer document");

      await store.invalidate(organizationId, "mcp", at(20));
      assert(await documentOf("mcp") === null, "an invalidated snapshot is still served");
      await store.write(organizationId, runtimeId, "mcp", { beforeWrite: true }, at(15));
      assert(await documentOf("mcp") === null, "a read observed before the invalidation wrote back");
      await store.write(organizationId, runtimeId, "mcp", { afterWrite: true }, at(25));
      assert(Bun.deepEquals(await documentOf("mcp"), { afterWrite: true }), "the proof read after the invalidation was not kept");

      // No row yet: the invalidation still leaves a tombstone that fences.
      await store.invalidate(organizationId, "models", at(30));
      await store.write(organizationId, runtimeId, "models", { beforeWrite: true }, at(28));
      assert(await documentOf("models") === null, "a pre-invalidation read created a row for a runtime that had none");

      assert(await store.read(otherOrganizationId, runtimeId, "mcp") === null, "another tenant reads the snapshot");
      await tx`reset role`;
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  console.info("Runtime read snapshot store passed: jsonb object round-trip, newer-wins upsert, invalidation fence with tombstones, tenant isolation.");
});
