/** Diagnostic store proof on a disposable database; every fixture rolls back. */
import { withDisposablePostgres } from "./disposable-postgres";
import { createLinkLivenessStore } from "../../modules/runtime-link/src/application/broker";
import type { Db } from "../../platform/db/src/db";
import type { RelayDiagnosticFrame } from "@openedbot/contracts-connector";

await withDisposablePostgres("openedbot50_diagnostics", async ({ owner: db }) => {
const organizationId = crypto.randomUUID();
const otherOrganizationId = crypto.randomUUID();
const runtimeId = crypto.randomUUID();
const eventId = crypto.randomUUID();
const rollback = new Error("ROLLBACK_DIAGNOSTIC_FIXTURES");
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
try {
  try {
    await db.begin(async (tx) => {
      await tx`insert into organizations (id, slug, name) values
        (${organizationId}, ${`diagnostic-${organizationId}`}, 'Diagnostic integration fixture'),
        (${otherOrganizationId}, ${`diagnostic-${otherOrganizationId}`}, 'Other diagnostic fixture')`;
      await tx`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active)
        values (${runtimeId}, ${organizationId}, 'Diagnostic fixture', 'connector', 'diagnostic-fixture-hash', false)`;
      await tx`set local role openedbot_api`;
      const scopedDb = { begin: (callback: (transaction: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as Db;
      const store = createLinkLivenessStore(scopedDb);
      const link = { runtimeId, organizationId, tokenHash: 'diagnostic-fixture-hash', expiresAt: null };
      const frame: RelayDiagnosticFrame = { t: 'diagnostic', eventId, component: 'operator', state: 'unavailable',
        code: 'OPERATOR_UNAVAILABLE', occurredAt: new Date().toISOString(), message: 'Bearer fixture-secret',
        stack: 'connector.readCapabilities\napi_key=fixture-secret\nclient.go:124' };
      await store.diagnostic!(link, frame);
      await store.diagnostic!(link, frame);
      const rows = await tx`select message, stack from runtime_link_diagnostics where runtime_id = ${runtimeId}`;
      assert(rows.length === 1, 'duplicate event was persisted twice');
      assert(rows[0].message === 'Bearer [redacted]', 'message was not redacted');
      assert(rows[0].stack === 'connector.readCapabilities\napi_key=[redacted]\nclient.go:124', 'stack did not roundtrip with redaction');
      await tx`select set_config('app.organization_id', ${otherOrganizationId}, true)`;
      const hidden = await tx`select id from runtime_link_diagnostics where runtime_id = ${runtimeId}`;
      assert(hidden.length === 0, 'another tenant can read the diagnostic');
      await tx`savepoint denied_write`;
      let denied = false;
      try {
        await tx`insert into runtime_link_diagnostics
          (organization_id, runtime_id, event_id, component, state, code, message, occurred_at)
          values (${organizationId}, ${runtimeId}, ${crypto.randomUUID()}, 'link', 'unavailable', 'LINK_UNAVAILABLE', 'fixture', now())`;
      } catch { denied = true; await tx`rollback to savepoint denied_write`; }
      assert(denied, 'another tenant can insert the diagnostic');
      await tx`reset role`;
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  const remaining = await db`select id from organizations where id in (${organizationId}, ${otherOrganizationId})`;
  assert(remaining.length === 0, 'fixtures were not rolled back');
  console.info('Diagnostic DB integration passed: actual store, duplicate suppression, sanitized stack, tenant read/write isolation, rollback cleanup.');
} finally { /* the disposable database is dropped by the helper */ }
});
