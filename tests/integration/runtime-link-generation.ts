/** Real SQL fencing proof on a disposable database (every migration applied).
 * Fixtures run in one rolled-back transaction; never touches the live ohb DB.
 */
import { withDisposablePostgres } from "./disposable-postgres";
import { createLinkLivenessStore, LinkLeaseLostError } from "../../modules/runtime-link/src/application/broker";
import type { Db } from "../../platform/db/src/db";

await withDisposablePostgres("ohb50_generation", async ({ owner: db }) => {
const organizationId = crypto.randomUUID(), runtimeId = crypto.randomUUID();
const rollback = new Error("ROLLBACK_GENERATION_FIXTURES");
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
let fencedWrites = 0;
try {
  try {
    await db.begin(async (tx) => {
      await tx`insert into organizations (id, slug, name) values (${organizationId}, ${`generation-${organizationId}`}, 'Generation test fixture')`;
      await tx`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active)
        values (${runtimeId}, ${organizationId}, 'Generation fixture', 'connector', 'generation-current-hash', false)`;
      const scopedDb = { begin: (callback: (transaction: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as Db;
      const store = createLinkLivenessStore(scopedDb);
      const identity = { runtimeId, organizationId, tokenHash: 'generation-current-hash', expiresAt: null };
      const fence = async (action: () => Promise<unknown>) => {
        let rejected = false;
        try { await action(); } catch (error) { if (!(error instanceof LinkLeaseLostError)) throw error; rejected = true; }
        assert(rejected, 'stale write was not fenced');
        fencedWrites++;
      };
      await tx`set local role ohb_api`;
      const old = { ...identity, generation: await store.reserveGeneration!(identity) };
      const sameProcessWinner = { ...identity, generation: await store.reserveGeneration!(identity) };
      assert(BigInt(sameProcessWinner.generation) > BigInt(old.generation), 'reservations are not monotonic');
      await store.connected(sameProcessWinner, 'api-a', ['winner_same_process']);
      for (const instance of ['api-a', 'api-b']) {
        await fence(() => store.connected(old, instance, ['stale']));
        await fence(() => store.seen(old, instance));
        await fence(() => store.capabilities!(old, instance, ['stale']));
        await fence(() => store.disconnected(old, instance, 'test'));
      }
      const crossProcessWinner = { ...identity, generation: await store.reserveGeneration!(identity) };
      await store.connected(crossProcessWinner, 'api-b', ['winner_cross_process']);
      await fence(() => store.connected(sameProcessWinner, 'api-a', []));
      await fence(() => store.seen(sameProcessWinner, 'api-a'));
      await fence(() => store.capabilities!(sameProcessWinner, 'api-a', []));
      await fence(() => store.disconnected(sameProcessWinner, 'api-a', 'test'));
      // An acknowledged claim retry is idempotent; it keeps its generation.
      await store.connected(crossProcessWinner, 'api-b', ['winner_cross_process']);
      await store.seen(crossProcessWinner, 'api-b');
      let rows = await tx`select link_generation::text as generation, link_instance_id as instance, link_features as features from runtimes where id = ${runtimeId}`;
      assert(rows[0].generation === crossProcessWinner.generation && rows[0].instance === 'api-b' && rows[0].features[0] === 'winner_cross_process', 'winner was overwritten');
      const diagnostic = {
        t: 'diagnostic' as const, eventId: crypto.randomUUID(), component: 'link' as const,
        state: 'recovered' as const, code: 'E2E_TEST', occurredAt: new Date().toISOString(),
        message: 'Synthetic correlation fixture', stack: 'fixture\nfixture.go:1',
      };
      await store.diagnostic!(crossProcessWinner, diagnostic, 'api-b');
      await store.diagnostic!(sameProcessWinner, diagnostic, 'api-a');
      const diagnostics = await tx`select receiver_instance_id as instance, receiver_generation::text as generation
        from runtime_link_diagnostics where runtime_id = ${runtimeId} and event_id = ${diagnostic.eventId}`;
      assert(diagnostics.length === 1 && diagnostics[0].instance === 'api-b' && diagnostics[0].generation === crossProcessWinner.generation,
        'diagnostic duplicate overwrote original receiving connection');
      const eventMeta = { instanceId: 'api-b', generation: crossProcessWinner.generation, closeCode: 1012, closeReason: 'LINK_DRAIN_TIMEOUT', ownershipCurrent: true };
      await store.event!(crossProcessWinner, 'disconnected', { ip: null, agent: null, ...eventMeta });
      const journal = await tx`select meta from runtime_link_events where runtime_id = ${runtimeId}`;
      assert(journal.length === 1 && Object.entries(eventMeta).every(([key, value]) => journal[0].meta[key] === value),
        'connection journal correlation was not persisted');
      await store.disconnected(crossProcessWinner, 'api-b', 'test');
      await fence(() => store.connected(crossProcessWinner, 'api-b', []));
      await fence(() => store.seen(crossProcessWinner, 'api-b'));
      rows = await tx`select link_instance_id as instance, link_connected_at as connected from runtimes where id = ${runtimeId}`;
      assert(rows[0].instance === null && rows[0].connected === null, 'released lease was resurrected');
      // RLS + explicit tenant and token checks also apply to reservations.
      await fence(() => store.reserveGeneration!({ ...identity, organizationId: crypto.randomUUID() }));
      await fence(() => store.reserveGeneration!({ ...identity, tokenHash: 'wrong-hash' }));
      await tx`reset role`;
      await tx`update runtimes set link_token_hash = 'generation-new-hash', link_token_previous_hash = 'generation-current-hash', link_token_previous_expires_at = now() + interval '1 minute' where id = ${runtimeId}`;
      await tx`set local role ohb_api`;
      const grace = { ...identity, generation: await store.reserveGeneration!(identity) };
      await store.connected(grace, 'api-grace', ['grace']);
      await tx`reset role`;
      await tx`update runtimes set link_token_previous_expires_at = now() - interval '1 second' where id = ${runtimeId}`;
      await tx`set local role ohb_api`;
      await fence(() => store.seen(grace, 'api-grace'));
      await fence(() => store.reserveGeneration!(identity));
      await tx`reset role`;
      await tx`update runtimes set revoked_at = now(), is_active = false where id = ${runtimeId}`;
      await tx`set local role ohb_api`;
      await fence(() => store.reserveGeneration!({ ...identity, tokenHash: 'generation-new-hash' }));
      await tx`reset role`;
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  const remaining = await db`select id from organizations where id = ${organizationId}`;
  assert(remaining.length === 0, 'generation fixtures were not rolled back');
  console.info(JSON.stringify({ test: 'runtime-link-generation-real-db', passed: true, fencedWrites, receiverCorrelation: true, journalCorrelation: true, fixturesRolledBack: true }));
} finally { /* the disposable database is dropped by the helper */ }
});
