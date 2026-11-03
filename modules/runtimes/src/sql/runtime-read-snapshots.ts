import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import type { RuntimeReadKind, SnapshotStore } from "@openedbot/runtimes/application/runtime-read-snapshots";

const ALL_KINDS: readonly RuntimeReadKind[] = ["mcp", "models", "profiles", "integrations"];

export function postgresSnapshotStore(db: Db): SnapshotStore {
  return {
    async read(organizationId, runtimeId, kind) {
      const rows = await withTenant(db, organizationId, (tx) => tx<Array<{ document: unknown; observedAt: Date }>>`
        select document, observed_at as "observedAt" from runtime_read_snapshots
         where organization_id = ${organizationId} and runtime_id = ${runtimeId} and kind = ${kind}
           and document is not null
           and (invalidated_at is null or observed_at > invalidated_at)
         limit 1
      `);
      // The table only holds jsonb objects (runtime_read_snapshots_document_check):
      // a document encoded twice fails its write instead of being served back.
      return rows[0] ?? null;
    },
    async write(organizationId, runtimeId, kind, document, observedAt) {
      // The fence: an observation that began before the last invalidation, or
      // before the document already kept, changes nothing.
      await withTenant(db, organizationId, (tx) => tx`
        insert into runtime_read_snapshots as snapshot (organization_id, runtime_id, kind, document, observed_at)
        values (${organizationId}, ${runtimeId}, ${kind}, ${JSON.stringify(document)}::text::jsonb, ${observedAt})
        on conflict (organization_id, runtime_id, kind) do update
          set document = excluded.document, observed_at = excluded.observed_at
          where (snapshot.invalidated_at is null or excluded.observed_at > snapshot.invalidated_at)
            and (snapshot.document is null or excluded.observed_at > snapshot.observed_at)
      `);
    },
    async invalidate(organizationId, kind, at) {
      // A tombstone per runtime of the organization, row or not: a read in
      // flight in another process must find it when it tries to write back.
      const kinds = kind === undefined ? ALL_KINDS : [kind];
      await withTenant(db, organizationId, (tx) => tx`
        insert into runtime_read_snapshots as snapshot (organization_id, runtime_id, kind, document, observed_at, invalidated_at)
        select ${organizationId}, runtime.id, requested.kind, null, ${at}, ${at}
          from runtimes runtime
          cross join unnest(${pgTextArray(kinds)}::text[]) as requested(kind)
         where runtime.organization_id = ${organizationId}
        on conflict (organization_id, runtime_id, kind) do update
          set document = null, invalidated_at = greatest(snapshot.invalidated_at, excluded.invalidated_at)
      `);
    },
  };
}
