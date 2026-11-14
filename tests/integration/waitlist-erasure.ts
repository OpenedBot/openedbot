/**
 * Plan 0005, delivery 2: migration 0180 on a database that still holds a
 * waitlist, the way production does. Migrated up to 0179, seeded, then 0180:
 * no trace of the waitlist is left, every account is kept, and a late worker
 * cannot bring an erased e-mail back.
 */
import { withDisposablePostgres } from "./disposable-postgres";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const WAITLIST_KINDS = ["waitlist_confirmation", "waitlist_access_granted", "waitlist_access_tier_changed", "waitlist_access_revoked"];
const STATUSES = ["pending", "sending", "sent", "failed"];
const KEPT_OUTBOX = "68000000-0000-4000-8000-0000000000ff";

await withDisposablePostgres("openedbot0005_waitlist_erasure", async ({ owner, connect, migrateRest }) => {
  // 1. What production holds before 0180: sign-ups in every state, accounts
  // with a tier, waitlist e-mails in every status with their events, an event
  // whose e-mail row is already gone, a flag with a tier audience.
  await owner`insert into waitlist_signups (email, locale, access_tier, approved_at) values
    ('approved@erasure.test', 'fr', 'alpha', now())`;
  await owner`insert into waitlist_signups (email, locale) values ('pending@erasure.test', 'en')`;
  await owner`insert into waitlist_signups (email, locale, rejected_at, rejection_reason) values
    ('rejected@erasure.test', 'fr', now(), 'probe')`;
  await owner`insert into users (id, email, access_tier) values
    ('69000000-0000-4000-8000-000000000001', 'approved@erasure.test', 'alpha'),
    ('69000000-0000-4000-8000-000000000002', 'classic@erasure.test', 'classic'),
    ('69000000-0000-4000-8000-000000000003', 'untiered@erasure.test', null)`;
  const usersBefore = (await owner<Array<{ count: number }>>`select count(*)::int as count from users`)[0]!.count;

  let n = 0;
  for (const kind of WAITLIST_KINDS) {
    for (const status of STATUSES) {
      n += 1;
      const id = `68000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      // A `sending` row whose lease has run out: the worker that held it is stopped.
      await owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload, status, lease_owner, lease_expires_at)
        values (${id}, ${kind}, ${`erasure:${kind}:${status}`}, 'approved@erasure.test', 'fr', '{"webAppUrl":"https://x.test"}'::jsonb, ${status},
                ${status === "sending" ? "worker-old" : null}, ${status === "sending" ? new Date(Date.now() - 60_000) : null})`;
      await owner`insert into email_outbox_events (outbox_id, kind, event) values (${id}, ${kind}, 'queued')`;
    }
  }
  await owner`insert into email_outbox_events (outbox_id, kind, event) values (gen_random_uuid(), 'waitlist_access_revoked', 'lease_lost')`;
  await owner`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
    values (${KEPT_OUTBOX}, 'email_login_code', 'erasure:kept', 'untiered@erasure.test', 'fr', '{}'::jsonb)`;
  await owner`insert into email_outbox_events (outbox_id, kind, event) values (${KEPT_OUTBOX}, 'email_login_code', 'queued')`;
  await owner.begin(async (tx) => {
    await tx`select set_config('openedbot.product_flags_v2', 'on', true)`;
    await tx`update product_features set audience = 'beta', prod = true where feature_key = 'connector_only_enrollment'`;
  });

  // 2. A worker still sending a waitlist e-mail (live lease): 0180 refuses to
  // run, and leaves everything in place.
  await owner`update email_outbox set lease_expires_at = now() + interval '5 minutes' where dedupe_key = 'erasure:waitlist_confirmation:sending'`;
  let refused = "";
  try { await migrateRest(); } catch (error) { refused = String(error); }
  assert(refused.includes("a worker is still sending a waitlist e-mail"), `0180 ran over a live lease: ${refused || "no error"}`);
  const [kept] = await owner<Array<{ signups: number; mails: number }>>`
    select (select count(*)::int from waitlist_signups) as signups,
           (select count(*)::int from email_outbox where left(kind, 9) = 'waitlist_') as mails`;
  assert(kept?.signups === 3 && kept.mails === 16, `a refused 0180 changed data: ${JSON.stringify(kept)}`);

  // 3. The lease runs out (worker stopped): 0180 runs.
  await owner`update email_outbox set lease_expires_at = now() - interval '1 minute' where dedupe_key = 'erasure:waitlist_confirmation:sending'`;
  await migrateRest();

  const [table] = await owner<Array<{ name: string | null }>>`select to_regclass('waitlist_signups')::text as name`;
  assert(table?.name === null, "waitlist_signups survived 0180");
  const [traces] = await owner<Array<{ mails: number; events: number }>>`
    select (select count(*)::int from email_outbox where left(kind, 9) = 'waitlist_') as mails,
           (select count(*)::int from email_outbox_events where left(kind, 9) = 'waitlist_') as events`;
  assert(traces?.mails === 0 && traces.events === 0, `waitlist e-mails survived 0180: ${JSON.stringify(traces)}`);
  const [other] = await owner<Array<{ mails: number; events: number }>>`
    select (select count(*)::int from email_outbox where id = ${KEPT_OUTBOX}) as mails,
           (select count(*)::int from email_outbox_events where outbox_id = ${KEPT_OUTBOX}) as events`;
  assert(other?.mails === 1 && other.events === 1, `0180 erased another kind of e-mail: ${JSON.stringify(other)}`);

  // Every account is kept, without its tier.
  const usersAfter = (await owner<Array<{ count: number }>>`select count(*)::int as count from users`)[0]!.count;
  assert(usersAfter === usersBefore, `0180 deleted accounts: ${usersBefore} -> ${usersAfter}`);
  const tier = await owner`select 1 from information_schema.columns where table_name = 'users' and column_name = 'access_tier'`;
  assert(tier.length === 0, "users.access_tier survived 0180");

  // The flags: no waitlist row, the tier audience is staff, the legacy columns are gone.
  const flags = await owner<Array<{ key: string; prod: boolean; audience: string }>>`
    select feature_key as key, prod, audience from product_features order by feature_key`;
  assert(!flags.some((row) => row.key === "waitlist"), "the waitlist flag survived 0180");
  const tiered = flags.find((row) => row.key === "connector_only_enrollment");
  assert(tiered?.audience === "staff" && tiered.prod === true, `a tier audience was not narrowed to staff: ${JSON.stringify(tiered)}`);
  const legacy = await owner`select 1 from information_schema.columns where table_name = 'product_features' and column_name in ('enabled', 'staff_override')`;
  assert(legacy.length === 0, "a legacy product_features column survived 0180");

  // 4. A late worker of delivery 1 can bring nothing back: neither a waitlist
  // e-mail nor the `lease_lost` event of one it had claimed.
  const worker = await connect("openedbot_worker");
  let lateEvent = false;
  try {
    await worker`insert into email_outbox_events (outbox_id, kind, event) values (gen_random_uuid(), 'waitlist_confirmation', 'lease_lost')`;
  } catch { lateEvent = true; }
  assert(lateEvent, "a waitlist event was accepted after 0180");
  const api = await connect("openedbot_api");
  let lateMail = false;
  try {
    await api`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
      values (gen_random_uuid(), 'waitlist_confirmation', 'erasure:late', 'late@erasure.test', 'fr', '{}'::jsonb)`;
  } catch { lateMail = true; }
  assert(lateMail, "a waitlist e-mail was accepted after 0180");

  console.log("0005 PostgreSQL proof passed: 0180 erases the waitlist, keeps every account, refuses a live lease and any late waitlist trace.");
}, { stopBefore: "0180_" });
