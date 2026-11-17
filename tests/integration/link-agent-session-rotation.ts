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

      // Engine identity is persisted by the API role under the same admission lease.
      await tx`set local role openedbot_api`;
      await tx`select set_config('app.session_credential_hash', ${tokenHash}, true)`;
      await writeLinkAgent(tx, scope, { agent: "edge-setup/v1.5.11", hermesVersion: "0.22.6",
        engine: "acp:opencode", engineVersion: "preview 1", generation: "7" });
      await tx`reset role`;
      let engine = (await tx`select link_engine, link_engine_version from runtimes where id = ${runtimeId}`)[0]!;
      assert(engine.link_engine === "acp:opencode" && engine.link_engine_version === "preview 1", "hello engine identity not persisted");

      // An agent-less hello only writes engine identity, preserving the last agent declaration.
      await tx`update runtimes set link_agent_seen_at = ${past}::timestamptz,
        capabilities_changed_at = ${past}::timestamptz where id = ${runtimeId}`;
      await tx`set local role openedbot_api`;
      await tx`select set_config('app.session_credential_hash', ${tokenHash}, true)`;
      assert(!(await writeLinkAgent(tx, scope, { agent: null, hermesVersion: null,
        engine: "acp:opencode", engineVersion: "preview 2", generation: "7" })), "agent-less hello reported a capabilities mark");
      await tx`reset role`;
      const declaration = (await tx`select link_agent, link_agent_seen_at, link_hermes_version,
        capabilities_changed_at, link_engine, link_engine_version from runtimes where id = ${runtimeId}`)[0]!;
      assert(declaration.link_agent === "edge-setup/v1.5.11" && declaration.link_hermes_version === "0.22.6",
        "agent-less hello changed the agent or Hermes version");
      assert(declaration.link_agent_seen_at.toISOString() === new Date(past).toISOString()
        && declaration.capabilities_changed_at.toISOString() === new Date(past).toISOString(),
        "agent-less hello changed the agent timestamp or capabilities marker");
      assert(declaration.link_engine === "acp:opencode" && declaration.link_engine_version === "preview 2",
        "agent-less hello did not write the engine");

      // A legacy reconnect, even without agent, clears the identity back to Hermes.
      await tx`set local role openedbot_api`;
      await tx`select set_config('app.session_credential_hash', ${tokenHash}, true)`;
      await writeLinkAgent(tx, scope, { agent: null, hermesVersion: null, generation: "7" });
      await tx`reset role`;
      engine = (await tx`select link_engine, link_engine_version, link_agent from runtimes where id = ${runtimeId}`)[0]!;
      assert(engine.link_engine === null && engine.link_engine_version === null, "legacy reconnect retained the previous engine");
      assert(engine.link_agent === "edge-setup/v1.5.11", "agent-less reconnect erased the agent");

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
