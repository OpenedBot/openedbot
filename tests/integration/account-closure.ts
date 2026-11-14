import { createNativeSession, rotateNativeSession } from "../../modules/identity/src/sql/sessions";
import { hashCredential } from "@openedbot/platform-db/credential";
/** Run only against a freshly migrated disposable PostgreSQL instance. */
import assert from "node:assert/strict";
import { withDisposablePostgres } from "./disposable-postgres";
import { readAccountClosureState, scheduleAccountClosure, cancelAccountClosure, processAccountClosure } from "../../modules/identity/src/application/account-closure";
import { processTenantDeletion } from "../../modules/identity/src/application/tenant-deletion";
import { installSubscriptionPort } from "../../modules/identity/src/application/subscription-port";
import { tableSubscriptionPort } from "../../apps/api/tests/fixtures/table-subscription-port";

await withDisposablePostgres("openedbot185_account_closure", async ({ owner: admin, connect }) => {
  const api = await connect("openedbot_api");
  const api2 = await connect("openedbot_api");
  const worker = await connect("openedbot_worker");
  const noRuns = async () => {};
  const emptyOrg = "00000000-0000-0000-0000-000000000000";
  const scope = (userId: string, organizationId = emptyOrg) => ({ userId, organizationId });
  async function user() {
    const id = crypto.randomUUID();
    await admin`insert into users (id,email,password_hash,google_subject,display_name) values (${id}, ${id + "@closure.test"}, 'hash', ${id}, 'Person')`;
    await admin`insert into sessions (id,user_id,kind,access_expires_at,session_token_hash) values (${crypto.randomUUID()},${id},'web',now()+interval '1 day',${id})`;
    return id;
  }
  async function organization(owner: string) {
    const id = crypto.randomUUID();
    await admin`insert into organizations (id,slug,name) values (${id},${'closure-' + id.slice(0,8)},'Named workspace')`;
    await admin`insert into memberships (organization_id,user_id,role) values (${id},${owner},'owner')`;
    return id;
  }
  async function due(userId: string) {
    await admin`update account_deletions set purge_after=now()-interval '1 second',last_attempt_at=null where user_id=${userId}`;
    await admin`update tenant_deletions set purge_after=now()-interval '1 second' where organization_id in (select unnest(organization_ids) from account_deletions where user_id=${userId})`;
  }
  async function identityErased(id: string) {
    const [row] = await admin`select email,password_hash,google_subject,display_name from users where id=${id}`;
    assert.equal(row.email, `erased+${id}@erased.invalid`);
    assert.equal(row.password_hash, null); assert.equal(row.google_subject, null); assert.equal(row.display_name, null);
    assert.equal((await admin`select count(*)::int n from sessions where user_id=${id}`)[0].n,0);
  }
  try {
    installSubscriptionPort(tableSubscriptionPort);
    const orphan = await user();
    const first = await scheduleAccountClosure(api, scope(orphan), 30, noRuns, []);
    const retries = await Promise.all([scheduleAccountClosure(api, scope(orphan), 30, noRuns, []),scheduleAccountClosure(api2, scope(orphan), 30, noRuns, [])]);
    assert.deepEqual(retries, [first,first]);
    assert.equal(await processAccountClosure(worker, "https://example.test"), false);
    assert.deepEqual(await cancelAccountClosure(api,scope(orphan)),{cancelled:true,deletion:null});
    assert.deepEqual(await cancelAccountClosure(api,scope(orphan)),{cancelled:false,deletion:null});
    await scheduleAccountClosure(api, scope(orphan), 0, noRuns, []);
    assert.equal(await processAccountClosure(worker, "https://example.test"), true);
    await identityErased(orphan);
    await assert.rejects(admin`insert into sessions (id,user_id,kind,access_expires_at) values (${crypto.randomUUID()},${orphan},'web',now()+interval '1 day')`, /Account is closed/);
    await assert.rejects(admin`update users set google_subject='resurrection' where id=${orphan}`, /Account is closed/);
    console.log("PASS orphan, concurrent duplicate, grace, cancellation, credentials cannot resurrect");

    const owner = await user(), member = await user();
    const shared = await organization(owner);
    await admin`insert into memberships (organization_id,user_id,role) values (${shared},${member},'member')`;
    const section = crypto.randomUUID();
    await admin`insert into sections (id,organization_id,name,position) values (${section},${shared},'Shared data',0)`;
    assert.equal((await readAccountClosureState(api,scope(owner,shared))).blocker,"transfer_required");
    assert.equal((await readAccountClosureState(api,scope(member,shared))).eligible,true);
    await scheduleAccountClosure(api,scope(member,shared),0,noRuns,[]);
    assert.equal(await processAccountClosure(worker, "https://example.test"),true);
    await identityErased(member);
    assert.equal((await admin`select count(*)::int n from memberships where user_id=${member}`)[0].n,1);
    assert.ok((await admin`select revoked_at from memberships where user_id=${member}`)[0].revoked_at);
    assert.equal((await admin`select count(*)::int n from sections where id=${section}`)[0].n,1);
    assert.equal((await admin`select count(*)::int n from organizations where id=${shared}`)[0].n,1);
    console.log("PASS member closure preserves shared tenant, history and ownership");

    const multi = await user();
    const soloA = await organization(multi), soloB = await organization(multi);
    await admin`insert into memberships (organization_id,user_id,role) values (${shared},${multi},'member')`;
    const ids = [soloA,soloB].sort();
    await scheduleAccountClosure(api,scope(multi,soloA),30,noRuns,ids);
    assert.equal((await admin`select count(*)::int n from tenant_deletions where organization_id in (${soloA},${soloB})`)[0].n,2);
    await assert.rejects(admin`insert into memberships (organization_id,user_id,role) values (${shared},${orphan},'member')`, /Account closure pending/);
    const extra = await organization(owner);
    await assert.rejects(admin`insert into memberships (organization_id,user_id,role) values (${extra},${multi},'member')`, /Account closure pending/);
    await assert.rejects(admin`insert into memberships (organization_id,user_id,role) values (${soloA},${owner},'member')`, /Workspace account deletion pending/);
    await due(multi);
    const opts = {workerId:"closure-proof", webAppUrl:"https://example.test",deleteBlob:async()=>{},profileJobs:{cancelQueuedImports:async()=>{},cancelQueuedDeletes:async()=>{},lockImports:async()=>{}}};
    assert.equal(await processTenantDeletion(worker,opts),true);
    await assert.rejects(cancelAccountClosure(api,scope(multi,soloA)), /ne peut plus être annulée/);
    assert.equal((await admin`select email from users where id=${multi}`)[0].email,`${multi}@closure.test`);
    assert.equal(await processTenantDeletion(worker,opts),true);
    await due(multi);
    assert.equal(await processAccountClosure(worker, "https://example.test"),true);
    await identityErased(multi);
    assert.equal((await admin`select count(*)::int n from organizations where id=${shared}`)[0].n,1);
    console.log("PASS multi-workspace purge, partial cancellation refusal, worker recovery, shared data preserved");

    const closingOwner = await user(), otherOwner = await user();
    const team = await organization(closingOwner);
    await admin`insert into memberships (organization_id,user_id,role) values (${team},${otherOwner},'owner')`;
    await scheduleAccountClosure(api,scope(closingOwner,team),0,noRuns,[]);
    await admin`update memberships set revoked_at=now() where user_id=${otherOwner} and organization_id=${team}`;
    await assert.rejects(processAccountClosure(worker, "https://example.test"), /propriété/);
    assert.ok((await admin`select password_hash from users where id=${closingOwner}`)[0].password_hash);
    const unrelated = await organization(otherOwner);
    await admin`insert into tenant_deletions(organization_id,reason,purge_after) values (${unrelated},'subscription_ended',now())`;
    await due(closingOwner);
    assert.equal(await processTenantDeletion(worker,opts),true);
    assert.equal((await admin`select count(*)::int n from organizations where id=${unrelated}`)[0].n,0);
    assert.equal((await admin`select count(*)::int n from account_deletions where user_id=${closingOwner}`)[0].n,1);
    await cancelAccountClosure(api,scope(closingOwner,team));
    console.log("PASS final ownership revalidation leaves identity recoverable by cancellation");

    const billed = await user(), paidOrg = await organization(billed);
    await admin`insert into subscriptions (organization_id,status) values (${paidOrg},'active')`;
    await assert.rejects(scheduleAccountClosure(api,scope(billed,paidOrg),30,noRuns,[paidOrg]), /abonnements/);
    await admin`update subscriptions set status='inactive' where organization_id=${paidOrg}`;
    await scheduleAccountClosure(api,scope(billed,paidOrg),30,noRuns,[paidOrg]);
    await admin`update subscriptions set status='active' where organization_id=${paidOrg}`;
    await admin`delete from tenant_deletions where organization_id=${paidOrg}`;
    assert.deepEqual(await cancelAccountClosure(api,scope(billed,paidOrg)),{cancelled:true,deletion:null});
    await admin`update subscriptions set status='inactive' where organization_id=${paidOrg}`;
    await scheduleAccountClosure(api,scope(billed,paidOrg),0,noRuns,[paidOrg]);
    await admin`update subscriptions set status='active' where organization_id=${paidOrg}`;
    await admin`delete from tenant_deletions where organization_id=${paidOrg}`;
    await assert.rejects(processAccountClosure(worker,"https://example.test"), /abonnements/);
    await admin`update subscriptions set status='inactive' where organization_id=${paidOrg}`;
    await due(billed);
    assert.equal(await processAccountClosure(worker,"https://example.test"),false);
    assert.equal((await admin`select count(*)::int n from tenant_deletions where organization_id=${paidOrg}`)[0].n,1);
    await processTenantDeletion(worker,opts);
    await due(billed);
    assert.equal(await processAccountClosure(worker,"https://example.test"),true);
    await identityErased(billed);
    assert.equal((await admin`select count(*)::int n from email_outbox where dedupe_key=${'account-closure:'+billed}`)[0].n,1);
    console.log("PASS active subscription protection, billing cancellation and missing-job recovery, one final email");

    // A historical actor need never have had membership in this tenant.
    // Deleting users used to cascade this ingress; pseudonymization must not.
    const actor = await user(), group = crypto.randomUUID(), thread = crypto.randomUUID(), ingress = crypto.randomUUID();
    await admin`insert into bot_groups(id,organization_id,section_id,name,position) values (${group},${shared},${section},'History',1)`;
    await admin`insert into threads(id,organization_id,group_id,title,hermes_session_id) values (${thread},${shared},${group},'History',${thread})`;
    await admin`insert into message_ingress(id,organization_id,user_id,thread_id,operation,idempotency_key,request_hash,message_id,run_id)
      values (${ingress},${shared},${actor},${thread},'test',${crypto.randomUUID()},${'a'.repeat(64)},${crypto.randomUUID()},${crypto.randomUUID()})`;
    await scheduleAccountClosure(api,scope(actor),0,noRuns,[]);
    await processAccountClosure(worker,"https://example.test");
    await identityErased(actor);
    assert.equal((await admin`select count(*)::int n from message_ingress where id=${ingress}`)[0].n,1);
    console.log("PASS historical ingress without membership survives closure");

    for (let iteration=0; iteration<5; iteration++) {
      const racing = await user();
      const session = await createNativeSession(api,null,racing);
      await scheduleAccountClosure(api,scope(racing),0,noRuns,[]);
      await Promise.all([
        processAccountClosure(worker,"https://example.test"),
        rotateNativeSession(api,hashCredential(session.refreshToken),{userAgent:null,ip:null}),
      ]);
      await identityErased(racing);
    }
    console.log("PASS concurrent native refresh and identity finalization (five real transactions pairs)");

    const scheduling = await user(), schedulingOrg = await organization(scheduling);
    let concurrentJoin: Promise<unknown> | undefined;
    await scheduleAccountClosure(api,scope(scheduling,schedulingOrg),30,async () => {
      // The scheduler holds the organization lock and has inserted its tenant job.
      // The admission starts before commit and must re-read that job after waiting.
      concurrentJoin = Promise.resolve(admin`insert into memberships(organization_id,user_id,role)
        values (${schedulingOrg},${owner},'member')`).then(() => "unexpected admission", error => error);
      await new Promise(resolve => setTimeout(resolve,30));
    },[schedulingOrg]);
    assert.match(String(await concurrentJoin), /Workspace account deletion pending/);
    await cancelAccountClosure(api,scope(scheduling,schedulingOrg));
    console.log("PASS concurrent member admission cannot turn a confirmed solo purge into a shared purge");

    const foreign = await user();
    await scheduleAccountClosure(api,scope(foreign),30,noRuns,[]);
    await assert.rejects(api.begin(async tx => {
      await tx`select set_config('app.authenticating_user_id',${owner},true)`;
      assert.equal((await tx`select * from account_deletions where user_id=${foreign}`).length,0);
      await tx`insert into account_deletions(user_id,purge_after) values (${owner},now()),(${orphan},now())`;
    }), /row-level security/);
    await cancelAccountClosure(api,scope(foreign));
    console.log("PASS API RLS cannot read/write another identity's closure");
  } finally { installSubscriptionPort(null); }
});
