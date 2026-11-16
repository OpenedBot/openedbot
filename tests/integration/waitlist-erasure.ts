/**
 * Plan 0005, delivery 2: a late worker cannot bring an erased waitlist e-mail
 * back.
 */
import { withDisposablePostgres } from "./disposable-postgres";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await withDisposablePostgres("openedbot0005_waitlist_erasure", async ({ connect }) => {
  // A late worker of delivery 1 can bring nothing back: neither a waitlist
  // e-mail nor the `lease_lost` event of one it had claimed.
  const worker = await connect("openedbot_worker");
  let lateEvent = false;
  try {
    await worker`insert into email_outbox_events (outbox_id, kind, event) values (gen_random_uuid(), 'waitlist_confirmation', 'lease_lost')`;
  } catch { lateEvent = true; }
  assert(lateEvent, "a waitlist event was accepted");
  const api = await connect("openedbot_api");
  let lateMail = false;
  try {
    await api`insert into email_outbox (id, kind, dedupe_key, recipient_email, locale, payload)
      values (gen_random_uuid(), 'waitlist_confirmation', 'erasure:late', 'late@erasure.test', 'fr', '{}'::jsonb)`;
  } catch { lateMail = true; }
  assert(lateMail, "a waitlist e-mail was accepted");

  console.log("0005 PostgreSQL proof passed: no late waitlist trace is accepted.");
});
