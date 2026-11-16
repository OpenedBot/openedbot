/** Real SQL proof that a host upgrade rotates the Hermes sessions of its bots.
 * `writeLinkAgent` marks the root `capabilities_changed_at` (read by the worker
 * for every bot of the runtime, whatever its profile) only when the declared
 * agent changes from a recorded one: not on the first declaration, not on a
 * reconnect with the same agent, not under a stale link generation.
 * Fixtures run in one rolled-back transaction; `now()` is fixed within it, so
 * the marker is reset to a past instant between steps to tell them apart.
 */
import { withDisposablePostgres } from "./disposable-postgres";
import { writeLinkAgent } from "../../modules/runtimes/src/sql/runtime-link-rows";

await withDisposablePostgres("openedbot50_agent_rotation", async ({ owner: db }) => {
  const organizationId = crypto.randomUUID(), runtimeId = crypto.randomUUID();
  const tokenHash = "agent-rotation-current-hash";
  const past = "2026-11-12T23:22:00Z";
  const rollback = new Error("ROLLBACK_AGENT_ROTATION_FIXTURES");
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  try {
    await db.begin(async (tx) => {
      await tx`insert into organizations (id, slug, name) values (${organizationId}, ${`agent-rotation-${organizationId}`}, 'Agent rotation fixture')`;
      await tx`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active,
                                     link_connected_at, link_generation, profile_capabilities_changed_at)
        values (${runtimeId}, ${organizationId}, 'Agent rotation fixture', 'connector', ${tokenHash}, true,
                now(), 7, jsonb_build_object('testeur', ${past}::text))`;
      const scope = { runtimeId, organizationId, tokenHash };
      const hello = async (agent: string, generation = "7") => {
        await tx`set local role openedbot_api`;
        await tx`select set_config('app.session_credential_hash', ${tokenHash}, true)`;
        const marked = await writeLinkAgent(tx, scope, { agent, hermesVersion: "0.22.6", generation });
        await tx`reset role`;
        return marked;
      };
      const state = async () => (await tx`
        select link_agent as agent, capabilities_changed_at = now() as "markedNow", capabilities_changed_at as "changedAt",
               profile_capabilities_changed_at ->> 'testeur' as "profileChangedAt"
          from runtimes where id = ${runtimeId}`)[0] as { agent: string | null; markedNow: boolean | null; changedAt: Date | null; profileChangedAt: string | null };
      const resetMarker = () => tx`update runtimes set capabilities_changed_at = ${past}::timestamptz where id = ${runtimeId}`;

      // First declaration: nothing to rotate, the marker stays null.
      assert(!(await hello("edge-setup/v1.5.8")), "first declaration reported a mark");
      let row = await state();
      assert(row.agent === "edge-setup/v1.5.8" && row.changedAt === null, "first declaration marked the runtime");

      // Reconnect with the same agent: unchanged.
      await resetMarker();
      assert(!(await hello("edge-setup/v1.5.8")), "same-agent reconnect reported a mark");
      row = await state();
      assert(row.changedAt?.toISOString() === new Date(past).toISOString(), "same-agent reconnect moved the marker");

      // Upgrade: the root marker is set to now(), the per-profile map is untouched.
      assert(await hello("edge-setup/v1.5.11"), "agent change did not report a mark");
      row = await state();
      assert(row.agent === "edge-setup/v1.5.11" && row.markedNow === true, "agent change did not mark the runtime");
      assert(row.profileChangedAt !== null && new Date(row.profileChangedAt).toISOString() === new Date(past).toISOString(), "profile map was rewritten");

      // A stale link generation writes nothing, marker included.
      await resetMarker();
      assert(!(await hello("edge-setup/v1.5.12", "6")), "stale generation reported a mark");
      row = await state();
      assert(row.agent === "edge-setup/v1.5.11" && row.changedAt?.toISOString() === new Date(past).toISOString(), "stale generation wrote");
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  const remaining = await db`select id from organizations where id = ${organizationId}`;
  assert(remaining.length === 0, "agent rotation fixtures were not rolled back");
  console.info(JSON.stringify({ test: "link-agent-session-rotation-real-db", passed: true, fixturesRolledBack: true }));
});
