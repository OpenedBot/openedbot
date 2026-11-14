/**
 * Rework-flux-api step 5d against a disposable PostgreSQL database: the
 * effective vitality of a link and its validity horizon, read as the API
 * role inside its tenant transaction.
 */
import type { SQL } from "bun";
import { readLinkVitality } from "../../modules/runtimes/src/sql/link-vitality";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92590000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const RUNTIME = id(11);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await withDisposablePostgres("openedbot259_link_vitality", async ({ owner, connect }) => {
  const api = await connect("openedbot_api");
  const read = () => api.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${ORG}, true)`;
    return readLinkVitality(tx as unknown as Bun.TransactionSQL, ORG, RUNTIME);
  }) as Promise<Awaited<ReturnType<typeof readLinkVitality>>>;
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'acme-vitality', 'Acme')`;
  await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, capacity)
    values (${RUNTIME}, ${ORG}, 'Connector', 'connector', ${RUNTIME.replaceAll("-", "").padEnd(64, "0")}, true, 2)`;
  await owner`insert into api_instances (instance_id, internal_url, started_at, last_seen_at)
    values ('api-a', 'http://api.invalid:8790', now() - interval '1 hour', now() - interval '10 seconds')`;

  // 1. Never connected: not live, no horizon.
  let vitality = await read();
  assert(!vitality.live && vitality.validUntil === null, `never connected: ${JSON.stringify(vitality)}`);

  // 2. Open, fresh, owned by a live instance: live until the earliest
  // deadline (link seen 5 s ago + 45 s, instance 10 s ago + 60 s) plus 30 s.
  await owner`update runtimes set link_instance_id = 'api-a', link_connected_at = now(), link_last_seen_at = now() - interval '5 seconds' where id = ${RUNTIME}`;
  vitality = await read();
  const [clock] = await owner<Array<{ now: Date }>>`select now() as now`;
  const horizon = (vitality.validUntil?.getTime() ?? 0) - clock!.now.getTime();
  assert(vitality.live, "an open, fresh, owned link is live");
  assert(horizon > 65_000 && horizon <= 71_000, `horizon ${horizon} ms: link seen 5 s ago + 45 s + 30 s`);

  // 3. A link silent for 50 s is not live, even though `link_connected_at` is set.
  await owner`update runtimes set link_last_seen_at = now() - interval '50 seconds' where id = ${RUNTIME}`;
  vitality = await read();
  assert(!vitality.live && vitality.validUntil === null, `silent link: ${JSON.stringify(vitality)}`);

  // 4. The owner stopped, or replaced at its address by a newer live one: not live.
  await owner`update runtimes set link_last_seen_at = now() where id = ${RUNTIME}`;
  await owner`update api_instances set stopped_at = now() where instance_id = 'api-a'`;
  assert(!(await read()).live, "a link owned by a stopped instance is not live");
  await owner`update api_instances set stopped_at = null, last_seen_at = now() where instance_id = 'api-a'`;
  await owner`insert into api_instances (instance_id, internal_url, started_at, last_seen_at) values ('api-b', 'http://api.invalid:8790', now(), now())`;
  assert(!(await read()).live, "a link owned by a replaced instance is not live");
  // A newer instance that died at startup disqualifies nobody.
  await owner`update api_instances set last_seen_at = now() - interval '2 minutes' where instance_id = 'api-b'`;
  assert((await read()).live, "a dead newer instance does not disqualify the live owner");

  // 5. The owner silent for 70 s: not live.
  await owner`update api_instances set last_seen_at = now() - interval '70 seconds' where instance_id = 'api-a'`;
  assert(!(await read()).live, "a link owned by a silent instance is not live");

  // 6. Another tenant reads nothing of it.
  const other = await (api as SQL).begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${id(2)}, true)`;
    return readLinkVitality(tx as unknown as Bun.TransactionSQL, id(2), RUNTIME);
  }) as Awaited<ReturnType<typeof readLinkVitality>>;
  assert(!other.live && other.validUntil === null, "another tenant learns nothing");

  console.log("Rework-flux-api 5d PostgreSQL proof passed: effective link vitality and its horizon.");
});
