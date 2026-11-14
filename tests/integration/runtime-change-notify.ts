/**
 * Rework-flux-api step 5b against a disposable PostgreSQL database: the
 * `openedbot_runtime` NOTIFY (0178). It fires, after commit only, when a value
 * GET /api/runtime shows changes; never on a sign of life, a probe date, a
 * value written again unchanged, or a review proof rechecked.
 */
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92580000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const RUNTIME = id(11);
const DIRECT = id(12);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await withDisposablePostgres("openedbot258_runtime_notify", async ({ owner, connect }) => {
  const listener = await connect();
  const worker = await connect("openedbot_worker");
  const received: string[] = [];
  await listener.listen("openedbot_runtime", (payload: string) => { received.push(payload); });
  /** Runs `write`, then checks how many notifications it produced, all for `runtimeId`. */
  const expectNotifications = async (label: string, count: number, write: () => Promise<unknown>, runtimeId = RUNTIME) => {
    const expected = `${ORG}:${runtimeId}`;
    const before = received.length;
    await write();
    await sleep(150);
    const got = received.slice(before);
    assert(got.length === count, `${label}: expected ${count} notification(s), got ${JSON.stringify(got)}`);
    assert(got.every((payload) => payload === expected), `${label}: unexpected payload ${JSON.stringify(got)}`);
  };

  await owner`insert into organizations (id, slug, name, permission_pipeline) values (${ORG}, 'acme-runtime-notify', 'Acme', 'v2')`;
  await expectNotifications("a new runtime", 1, () => owner`
    insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, capacity, link_features)
    values (${RUNTIME}, ${ORG}, 'Connector', 'connector', ${RUNTIME.replaceAll("-", "").padEnd(64, "0")}, true, 4, '{approval_policy}'::text[])`);

  // The link opens (the broker), then beats (every few seconds).
  await expectNotifications("the link connects", 1, () => worker`
    update runtimes set link_instance_id = 'api-1', link_connected_at = now(), link_generation = 7, link_last_seen_at = now()
     where id = ${RUNTIME}`);
  await expectNotifications("a heartbeat", 0, () => worker`update runtimes set link_last_seen_at = now() where id = ${RUNTIME}`);
  await expectNotifications("an agent seen again", 0, () => worker`update runtimes set link_agent_seen_at = now(), updated_at = now(), last_probed_at = now() where id = ${RUNTIME}`);
  await expectNotifications("the same features written again", 0, () => worker`update runtimes set link_features = '{approval_policy}'::text[] where id = ${RUNTIME}`);
  await expectNotifications("new features", 1, () => worker`update runtimes set link_features = '{approval_policy,profile_management}'::text[] where id = ${RUNTIME}`);

  // The worker's sweep: a silent link becomes disconnected.
  await expectNotifications("the sweep disconnects", 1, () => worker`
    update runtimes set last_health_status = 'disconnected', link_instance_id = null, link_connected_at = null where id = ${RUNTIME}`);
  await expectNotifications("a rolled back write", 0, async () => {
    await worker.begin(async (tx) => {
      await tx`update runtimes set name = 'Renamed' where id = ${RUNTIME}`;
      throw new Error("rollback");
    }).catch(() => undefined);
  });
  await expectNotifications("a preference", 1, () => owner`update runtimes set selected_model = 'gpt-5' where id = ${RUNTIME}`);
  // A direct runtime (inactive: one active runtime per organization).
  await expectNotifications("a direct runtime", 1, () => owner`
    insert into runtimes (id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, is_active, capacity)
    values (${DIRECT}, ${ORG}, 'Direct', 'direct', 'https://hermes.invalid', 'c'::bytea, 'n'::bytea, 't'::bytea, false, 2)`, DIRECT);
  await expectNotifications("edge credentials added", 1, () => owner`
    update runtimes set edge_auth_ciphertext = 'x'::bytea, edge_auth_nonce = 'n'::bytea, edge_auth_tag = 't'::bytea, edge_auth_key_id = 'k1'
     where id = ${DIRECT}`, DIRECT);
  await expectNotifications("edge credentials re-encrypted", 0, () => owner`
    update runtimes set edge_auth_ciphertext = 'y'::bytea, edge_auth_key_id = 'k2' where id = ${DIRECT}`, DIRECT);
  await expectNotifications("edge credentials removed", 1, () => owner`
    update runtimes set edge_auth_ciphertext = null, edge_auth_nonce = null, edge_auth_tag = null, edge_auth_key_id = null where id = ${DIRECT}`, DIRECT);
  await expectNotifications("a link replaced", 1, () => owner`
    insert into runtime_link_events (organization_id, runtime_id, kind) values (${ORG}, ${RUNTIME}, 'replaced')`);
  await expectNotifications("a plain link event", 0, () => owner`
    insert into runtime_link_events (organization_id, runtime_id, kind) values (${ORG}, ${RUNTIME}, 'connected')`);

  // The review proof: gained or lost fires, a recheck does not.
  await expectNotifications("a review profile queued", 1, () => owner`
    insert into runtime_review_profiles (runtime_id, organization_id) values (${RUNTIME}, ${ORG})`);
  await expectNotifications("a proof gained", 1, () => worker`
    update runtime_review_profiles set status = 'proven', proven_at = now(), checked_at = now() where runtime_id = ${RUNTIME}`);
  await expectNotifications("a recheck", 0, () => worker`
    update runtime_review_profiles set checked_at = now(), next_check_at = now() + interval '2 minutes', proven_at = now(), attempts = 0
     where runtime_id = ${RUNTIME}`);
  // A proof kept past its window (host unreachable), then renewed: fresh again.
  await owner`alter table runtime_review_profiles disable trigger runtime_review_profiles_change_notify`;
  await owner`update runtime_review_profiles set proven_at = now() - interval '11 minutes' where runtime_id = ${RUNTIME}`;
  await owner`alter table runtime_review_profiles enable trigger runtime_review_profiles_change_notify`;
  await expectNotifications("an expired proof made fresh again", 1, () => worker`
    update runtime_review_profiles set proven_at = now(), checked_at = now() where runtime_id = ${RUNTIME}`);
  await expectNotifications("a proof lost", 1, () => worker`
    update runtime_review_profiles set status = 'failed', proven_at = null where runtime_id = ${RUNTIME}`);

  // Provider incidents: opened, renewed, expired then back, closed.
  await expectNotifications("an incident opens", 1, () => owner`
    insert into runtime_provider_incidents (organization_id, runtime_id, provider, kind, first_seen_at, last_seen_at, until)
    values (${ORG}, ${RUNTIME}, 'openai', 'quota', now(), now(), now() + interval '1 hour')`);
  await expectNotifications("an incident seen again", 0, () => owner`
    update runtime_provider_incidents set last_seen_at = now(), until = now() + interval '2 hours' where runtime_id = ${RUNTIME}`);
  await expectNotifications("an incident expired by a write", 1, () => owner`
    update runtime_provider_incidents set until = now() - interval '1 minute' where runtime_id = ${RUNTIME}`);
  await expectNotifications("an expired incident back", 1, () => owner`
    update runtime_provider_incidents set last_seen_at = now(), until = now() + interval '1 hour' where runtime_id = ${RUNTIME}`);
  await expectNotifications("an incident closed", 1, () => owner`delete from runtime_provider_incidents where runtime_id = ${RUNTIME}`);

  await expectNotifications("the runtime revoked", 1, () => owner`update runtimes set revoked_at = now(), is_active = false where id = ${RUNTIME}`);

  console.log("Rework-flux-api 5b PostgreSQL proof passed: openedbot_runtime fires on meaning, never on a sign of life.");
});
