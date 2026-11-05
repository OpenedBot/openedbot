/**
 * PERM2-7a against a disposable PostgreSQL database: the
 * review profile queue (0139). Only an active connector runtime of a `v2`
 * organization whose link announces the needed features is queued; a claim
 * is exclusive; a stale lease writes nothing; the API reads its own tenant
 * and writes nothing; a proof only counts while fresh and for the active
 * runtime.
 */
import type { SQL } from "bun";
import { claimReviewProfile, enqueueReviewProfiles, finishReviewProfile, readReviewProven } from "../../modules/runtimes/src/sql/review-profiles";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92570000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const V2 = id(1);
const LEGACY = id(2);
const BARE = id(3);
const RUNTIME_V2 = id(11);
const RUNTIME_LEGACY = id(12);
const RUNTIME_BARE = id(13);
const FEATURES = "{profile_management,profile_capabilities,approval_policy}";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function asTenant<T>(sql: SQL, organizationId: string, run: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return run(tx as unknown as SQL);
  }) as Promise<T>;
}

await withDisposablePostgres("openedbot257_review_profiles", async ({ owner, connect }) => {
  const worker = await connect("openedbot_worker");
  const api = await connect("openedbot_api");
  for (const [org, slug, pipeline] of [[V2, "acme-review", "v2"], [LEGACY, "acme-legacy", "legacy"], [BARE, "acme-bare", "v2"]] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Acme', ${pipeline})`;
  }
  for (const [runtime, org, features] of [[RUNTIME_V2, V2, FEATURES], [RUNTIME_LEGACY, LEGACY, FEATURES], [RUNTIME_BARE, BARE, "{approval_policy}"]] as const) {
    await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, capacity, link_features)
      values (${runtime}, ${org}, 'Connector', 'connector', ${runtime.replaceAll("-", "").padEnd(64, "0")}, true, 4, ${features}::text[])`;
  }

  // 1. Only the qualifying runtime is queued, and queuing twice is a no-op.
  await enqueueReviewProfiles(worker);
  await enqueueReviewProfiles(worker);
  const queued = await owner<Array<{ runtime_id: string }>>`select runtime_id from runtime_review_profiles`;
  assert(queued.length === 1 && queued[0]!.runtime_id === RUNTIME_V2, `unexpected queue: ${JSON.stringify(queued)}`);

  // 2. A claim is exclusive while its lease lives.
  const job = await claimReviewProfile(worker, "worker-a");
  assert(job?.runtime_id === RUNTIME_V2 && job.status === "queued", `claim failed: ${JSON.stringify(job)}`);
  assert(job.link_features.includes("approval_policy"), "the claim must carry the link features");
  assert((await claimReviewProfile(worker, "worker-b")) === null, "a leased row was claimed twice");

  // 3. A stale lease writes nothing.
  assert(!(await finishReviewProfile(worker, { ...job, lease_token: id(99) }, { status: "proven" })), "a stale lease recorded a proof");
  assert(!(await asTenant(worker, V2, (tx) => readReviewProven(tx, V2))), "an unrecorded proof counted");

  // 4. The proof counts for its tenant only; the API reads it and writes nothing.
  assert(await finishReviewProfile(worker, job, { status: "proven" }), "the leased proof was not recorded");
  assert(await asTenant(worker, V2, (tx) => readReviewProven(tx, V2)), "a fresh proof did not count");
  assert(await asTenant(api, V2, (tx) => readReviewProven(tx, V2)), "the API cannot read its own proof");
  assert(!(await asTenant(api, LEGACY, (tx) => readReviewProven(tx, V2))), "the API read another tenant's proof");
  let refused = false;
  try {
    await asTenant(api, V2, (tx) => tx`update runtime_review_profiles set status = 'proven' where runtime_id = ${RUNTIME_V2}`);
  } catch { refused = true; }
  assert(refused, "the API could write the review proof");

  // 5. A proven row is not due before its recheck.
  assert((await claimReviewProfile(worker, "worker-a")) === null, "a fresh proof was claimed again at once");

  // 6a. A check that did not reach the host (gateway restarting) keeps a
  // fresh proof: `proven_at` unchanged, so it still ages out.
  await owner`update runtime_review_profiles set next_check_at = now() where runtime_id = ${RUNTIME_V2}`;
  const [fresh] = await owner<Array<{ provenAt: Date }>>`select proven_at as "provenAt" from runtime_review_profiles where runtime_id = ${RUNTIME_V2}`;
  const provenAt = fresh!.provenAt;
  const unreachable = await claimReviewProfile(worker, "worker-a");
  assert(unreachable, "the due row was not claimed");
  assert(await finishReviewProfile(worker, unreachable, { status: "failed", failureCode: "HERMES_UNREACHABLE", transient: true }), "the kept proof was not recorded");
  const kept = (await owner<Array<{ status: string; proven_at: Date | null; failure_code: string | null; lease: string | null }>>`
    select status, proven_at, failure_code, lease_token as lease from runtime_review_profiles where runtime_id = ${RUNTIME_V2}`)[0];
  assert(kept?.status === "proven" && kept.proven_at?.getTime() === provenAt.getTime() && kept.failure_code === "HERMES_UNREACHABLE" && kept.lease === null,
    `a transient failure dropped the proof: ${JSON.stringify(kept)}`);
  assert(await asTenant(worker, V2, (tx) => readReviewProven(tx, V2)), "a kept proof did not count");

  // 6b. A failure the host answered clears the proof at once and keeps its code.
  await owner`update runtime_review_profiles set next_check_at = now() where runtime_id = ${RUNTIME_V2}`;
  const again = await claimReviewProfile(worker, "worker-a");
  assert(again, "the due row was not claimed");
  await finishReviewProfile(worker, again, { status: "failed", failureCode: "REVIEW_PROFILE_TOOLS_ACTIVE" });
  const failed = (await owner<Array<{ status: string; proven_at: Date | null; failure_code: string | null }>>`
    select status, proven_at, failure_code from runtime_review_profiles where runtime_id = ${RUNTIME_V2}`)[0];
  assert(failed?.status === "failed" && failed.proven_at === null && failed.failure_code === "REVIEW_PROFILE_TOOLS_ACTIVE",
    `a failure kept the proof: ${JSON.stringify(failed)}`);
  assert(!(await asTenant(worker, V2, (tx) => readReviewProven(tx, V2))), "a failed proof counted");

  // 7. A stale proof, or a proof of a runtime no longer active, does not count.
  await owner`update runtime_review_profiles set status = 'proven', proven_at = now() - interval '11 minutes', failure_code = null where runtime_id = ${RUNTIME_V2}`;
  assert(!(await asTenant(worker, V2, (tx) => readReviewProven(tx, V2))), "a stale proof counted");
  await owner`update runtime_review_profiles set proven_at = now() where runtime_id = ${RUNTIME_V2}`;
  await owner`update runtimes set is_active = false where id = ${RUNTIME_V2}`;
  assert(!(await asTenant(worker, V2, (tx) => readReviewProven(tx, V2))), "the proof of an inactive runtime counted");

  // 8. An organization back on legacy is no longer claimed.
  await owner`update runtimes set is_active = true where id = ${RUNTIME_V2}`;
  await owner`update runtime_review_profiles set next_check_at = now() where runtime_id = ${RUNTIME_V2}`;
  await owner`update organizations set permission_pipeline = 'legacy' where id = ${V2}`;
  assert((await claimReviewProfile(worker, "worker-a")) === null, "a legacy organization was claimed");

  console.log("PERM2-7a PostgreSQL proof passed: review profile queue, lease, tenant read and freshness.");
});
