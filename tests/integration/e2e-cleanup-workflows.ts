import { withDisposablePostgres } from "./disposable-postgres";
import { readThreadCompaction } from "../../modules/conversation/src/application/compact-thread";
import { forceOnlyOwnedGroupRefusal, readCleanupGroups } from "../e2e/bot/kit/cleanup-groups";
import { cleanupStore, settleCleanupWork } from "../e2e/bot/kit/cleanup-workflows";
import { readRunEvidence } from "../e2e/bot/kit/bots";

const id = (n: number) => `90231000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function refuses(operation: () => Promise<unknown>, fragment: string): Promise<void> {
  try { await operation(); } catch (error) {
    assert(error instanceof Error && error.message.includes(fragment), `Expected cleanup refusal containing ${fragment}.`);
    return;
  }
  throw new Error(`Cleanup unexpectedly accepted ${fragment}.`);
}

await withDisposablePostgres("openedbot023_e2e_cleanup", async ({ owner, connect }) => {
  const organization = id(1), otherOrganization = id(2), section = id(10);
  const a = id(20), b = id(21), foreign = id(22), otherTenantBot = id(23);
  const dmA = id(30), dmB = id(31), groupThread = id(35), group = id(40);
  const workflowId = id(50), rootRun = id(60), memberRun = id(61);
  for (const [index, org] of [organization, otherOrganization].entries()) {
    await owner`insert into organizations (id,slug,name) values (${org},${`cleanup-${index}`},'Cleanup fixture')`;
    await owner`insert into sections (id,organization_id,name,position) values (${id(10 + index)},${org},'Bots',0)`;
  }
  for (const [index, bot] of [a, b, foreign, otherTenantBot].entries()) {
    const org = bot === otherTenantBot ? otherOrganization : organization;
    const botSection = bot === otherTenantBot ? id(11) : section;
    await owner`insert into bots (id,organization_id,section_id,name,slug,position)
      values (${bot},${org},${botSection},'Cleanup bot',${`cleanup-bot-${index}`},${index})`;
    await owner`insert into threads (id,organization_id,bot_id,title,hermes_session_id,is_default)
      values (${id(30 + index)},${org},${bot},'Cleanup DM',${`cleanup-dm-${index}`},true)`;
  }
  await owner`insert into bot_groups (id,organization_id,section_id,name,position)
    values (${group},${organization},${section},'Cleanup group',0)`;
  for (const [position, bot] of [a, b].entries()) await owner`
    insert into group_members (organization_id,group_id,bot_id,position) values (${organization},${group},${bot},${position})`;
  await owner`insert into threads (id,organization_id,group_id,title,hermes_session_id)
    values (${groupThread},${organization},${group},'Cleanup group','cleanup-group')`;
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status,step_kind,step_index)
    values (${rootRun},${organization},${groupThread},${a},'Cleanup root','unknown','root',0)`;
  await owner`insert into workflows (id,organization_id,thread_id,root_run_id,root_bot_id,kind,status)
    values (${workflowId},${organization},${groupThread},${rootRun},${a},'group','unknown')`;
  await owner`update runs set workflow_id=${workflowId} where id=${rootRun}`;
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status,step_kind,step_index,workflow_id,caller_bot_id,handoff_target_bot_id)
    values (${memberRun},${organization},${groupThread},${b},'Historical member','completed','group',1,${workflowId},${a},${b})`;

  const worker = await connect("openedbot_worker"), store = cleanupStore(worker), live = new Set([a, b]);
  assert((await readRunEvidence(worker, rootRun))?.executionSessionKey === "cleanup-group", "Generation-zero evidence must use the real thread session key.");
  await owner`update runs set execution_session_key='pinned-generation-one' where id=${memberRun}`;
  assert((await readRunEvidence(worker, memberRun))?.executionSessionKey === "pinned-generation-one", "A pinned run key must take precedence over the thread key.");
  assert(await readRunEvidence(worker, id(999)) === null, "Missing run evidence must remain absent.");
  // Migration 0082 deliberately hides summaries from an unscoped worker.
  // The acceptance assertion must use the same tenant-scoped reader as production.
  const proofs = ["FIXTURE_DOC_INITIAL", "12345", "FIXTURE_DOC_RECOVERY", "67890"];
  const summary = proofs.join(" ");
  await owner`insert into thread_compactions (organization_id,thread_id,summary,compacted_through_sequence,source_message_count)
    values (${organization},${groupThread},${summary},4,5), (${otherOrganization},${id(33)},'OTHER_TENANT_SUMMARY',2,2)`;
  const unscoped = await worker<Array<{ summary: string }>>`select summary from thread_compactions
    where organization_id=${organization} and thread_id=${groupThread}`;
  assert(unscoped.length === 0, "Unscoped worker must not read tenant-bound compaction evidence.");
  const scoped = await readThreadCompaction(worker, organization, groupThread);
  assert(scoped?.summary === summary && scoped.sourceMessageCount === 5 && scoped.compactedThroughSequence === 4
    && proofs.every((proof) => scoped.summary.includes(proof)), "Tenant-scoped reader must return the exact owned summary and all four proofs.");
  assert(await readThreadCompaction(worker, otherOrganization, groupThread) === null,
    "Wrong tenant must not read another organization's group summary.");
  assert(await readThreadCompaction(worker, organization, id(33)) === null,
    "Owned tenant context must not expose another organization's thread summary.");
  const afterScopedRead = await worker<Array<{ summary: string }>>`select summary from thread_compactions`;
  assert(afterScopedRead.length === 0, "Compaction reader must restore the worker's unscoped connection after its transaction.");
  let now = 0;
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  const actions: string[] = [];
  const settle = (botId = a, mutation: (path: string) => Promise<void> = async (path) => { actions.push(path); }) =>
    settleCleanupWork(store, mutation, botId, organization, live, 1_000, clock);
  const snapshot = await store.workflow(workflowId);
  assert(snapshot?.runs.length === 2, "Real SQL must include completed workflow members too.");
  assert(snapshot.owners.some((value) => value.botId === b && value.organizationId === organization), "Real SQL must join owned group members.");
  assert((await store.targets(a)).some((value) => value.workflowId === workflowId), "Unknown group workflow must be discoverable from its owned bot.");

  // A roster-only foreign bot is outside live BotLab ownership even without a run.
  await owner`insert into group_members (organization_id,group_id,bot_id,position) values (${organization},${group},${foreign},2)`;
  await refuses(() => settle(), "ownership"); assert(Number(actions.length) === 0, "Foreign group member must block every mutation.");
  await owner`delete from group_members where group_id=${group} and bot_id=${foreign}`;
  for (const column of ["bot_id", "caller_bot_id", "handoff_target_bot_id"] as const) {
    // Fixed test-only identifiers, never caller input.
    await owner.unsafe(`update runs set ${column}=$1 where id=$2`, [foreign, memberRun]);
    await refuses(() => settle(), "ownership"); assert(Number(actions.length) === 0, "Foreign historical member/caller/handoff must block cleanup.");
    await owner.unsafe(`update runs set ${column}=$1 where id=$2`, [column === "caller_bot_id" ? a : b, memberRun]);
  }
  await owner`delete from group_members where group_id=${group}`;
  await refuses(() => settle(), "ownership"); assert(Number(actions.length) === 0, "Empty group must produce an unproven owner sentinel.");
  for (const [position, bot] of [a, b].entries()) await owner`
    insert into group_members (organization_id,group_id,bot_id,position) values (${organization},${group},${bot},${position})`;
  const before = await owner<Array<{ status: string }>>`select status from runs where id=${rootRun}`;
  assert(before[0]?.status === "unknown", "Refused cleanup must leave persisted run state unchanged.");

  // The callback stands in for the authorized API endpoint; actual state is
  // persisted and subsequent adapter polls must observe it, not a mock object.
  await settle(a, async (path) => {
    actions.push(path);
    assert(path === `/api/workflows/${workflowId}/abandon`, "Unknown owned group must use explicit workflow abandonment.");
    await owner`update runs set status='failed', external_state='settled', ended_at=now() where workflow_id=${workflowId} and status='unknown'`;
    await owner`update workflows set status='failed', recovery_state=${{ resolution: "abandoned", duplicateRisk: true }}, ended_at=now() where id=${workflowId}`;
  });
  assert(Number(actions.length) === 1 && (await store.targets(a)).length === 0, "Cleanup must re-read real persisted settlement.");
  assert((await store.workflow(workflowId))?.runs.every((value) => ["failed", "completed"].includes(value.status)), "All workflow runs must read back settled.");

  // A non-speaking member still blocks DELETE: discover B's group workflow
  // for A even though no run in that workflow belongs to A.
  const silentWorkflow = id(53), speakerRun = id(65);
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status)
    values (${speakerRun},${organization},${groupThread},${b},'Only B speaks','running')`;
  await owner`insert into workflows (id,organization_id,thread_id,root_run_id,root_bot_id,kind,status)
    values (${silentWorkflow},${organization},${groupThread},${speakerRun},${b},'group','running')`;
  await owner`update runs set workflow_id=${silentWorkflow} where id=${speakerRun}`;
  assert((await store.workflow(silentWorkflow))?.runs.every((value) => value.botId === b), "A must have no speaking run in this workflow.");
  assert((await store.targets(a)).some((value) => value.id === speakerRun), "Group membership alone must discover another owned speaker.");
  const silentActions: string[] = [];
  await settle(a, async (path) => {
    silentActions.push(path); assert(path === `/api/workflows/${silentWorkflow}/cancel`, "Non-speaking member must settle its actual group workflow.");
    await owner`update runs set status='cancelled', ended_at=now() where id=${speakerRun}`;
    await owner`update workflows set status='cancelled', ended_at=now() where id=${silentWorkflow}`;
  });
  assert(silentActions.length === 1 && (await store.targets(a)).length === 0, "Group-only association must settle and re-poll.");

  // Mirror the other deletion guard associations independently.
  for (const [index, association] of ["caller", "handoff", "thread", "group"].entries()) {
    const associatedRun = id(90 + index);
    const thread = association === "thread" ? dmA : association === "group" ? groupThread : dmB;
    await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status,caller_bot_id,handoff_target_bot_id)
      values (${associatedRun},${organization},${thread},${b},'Associated work','queued',
        ${association === "caller" ? a : null},${association === "handoff" ? a : null})`;
    assert((await store.targets(a)).some((value) => value.id === associatedRun), `DELETE ${association} association must be discovered.`);
    if (association === "group") {
      await owner`insert into group_members (organization_id,group_id,bot_id,position) values (${organization},${group},${foreign},2)`;
      await refuses(() => settle(), "ownership");
      assert(Number(actions.length) === 1, "Standalone group discovery must not cancel through foreign group membership.");
      await owner`delete from group_members where group_id=${group} and bot_id=${foreign}`;
    }
    await settle(a, async (path) => {
      assert(path === `/api/runs/${associatedRun}/cancel`, "Standalone associated work must use its exact run endpoint.");
      await owner`update runs set status='cancelled', ended_at=now() where id=${associatedRun}`;
    });
  }

  // Force deletion can delete a two-member group: every roster must be owned.
  const ownedGroups = await readCleanupGroups(worker, a);
  assert(ownedGroups.length === 1 && ownedGroups[0]?.members.length === 2, "Real group force proof must include the entire roster.");
  let forced = 0;
  const force = () => forceOnlyOwnedGroupRefusal(Response.json({ error: { code: "BOT_IN_GROUP" } }, { status: 409 }),
    a, organization, live, () => readCleanupGroups(worker, a), async () => {}, async () => { forced++; return new Response(null, { status: 204 }); });
  await owner`insert into group_members (organization_id,group_id,bot_id,position) values (${organization},${group},${foreign},2)`;
  await refuses(force, "Forced purge refused"); assert(forced === 0, "A foreign roster must never authorize forced group deletion.");
  await owner`delete from group_members where group_id=${group} and bot_id=${foreign}`;
  assert((await force()).status === 204 && Number(forced) === 1, "An entirely owned settled group may authorize the exact forced request.");

  // A standalone courier cancellation affects its child: ownership must include
  // both before mutation, and settlement must poll both after the parent stops.
  const courier = id(70), child = id(71);
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status)
    values (${courier},${organization},${dmA},${a},'Standalone courier','relaying')`;
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status,origin_run_id)
    values (${child},${organization},${dmB},${b},'Standalone child','running',${courier})`;
  const standalone = await store.standalone(courier);
  assert(standalone?.run.workflowId === null && standalone.affectedRuns[0]?.id === child, "Real SQL must include standalone courier children.");
  const mixedWorkflow = id(52), mixedRoot = id(64);
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status)
    values (${mixedRoot},${organization},${id(32)},${foreign},'Foreign workflow root','queued')`;
  await owner`insert into workflows (id,organization_id,thread_id,root_run_id,root_bot_id,kind,status)
    values (${mixedWorkflow},${organization},${id(32)},${mixedRoot},${foreign},'dm','running')`;
  await owner`update runs set workflow_id=${mixedWorkflow} where id in (${mixedRoot},${child})`;
  const mixed = await store.standalone(courier);
  assert(mixed?.affectedRuns[0]?.botId === b && mixed.affectedRuns[0].workflowId === mixedWorkflow,
    "Owned child must retain its actual mixed workflow identity.");
  await refuses(() => settle(), "ownership");
  assert(Number(actions.length) === 1, "Owned child inside foreign workflow must not authorize courier cancellation.");
  const persistedMixed = await store.workflow(mixedWorkflow);
  assert(persistedMixed?.status === "running" && persistedMixed.runs.some((value) => value.id === mixedRoot && value.status === "queued"),
    "Foreign workflow envelope and root must remain untouched.");
  await owner`update runs set workflow_id=null where id=${child}`;
  await owner`update runs set status='cancelled', ended_at=now() where id=${mixedRoot}`;
  await owner`update workflows set status='cancelled', ended_at=now() where id=${mixedWorkflow}`;
  await owner`update runs set bot_id=${foreign} where id=${child}`;
  await refuses(() => settle(), "ownership"); assert(Number(actions.length) === 1, "Foreign courier child must not be cancelled.");
  await owner`update runs set bot_id=${b} where id=${child}`;
  await settle(a, async (path) => {
    actions.push(path); assert(path === `/api/runs/${courier}/cancel`, "Standalone cancellation must target its run ID.");
    await owner`update runs set status='cancelled', ended_at=now() where id in (${courier},${child})`;
  });
  assert((await store.standalone(courier))?.affectedRuns[0]?.status === "cancelled", "Child terminal state must read back from PostgreSQL.");
  assert((await store.targets(a)).length === 0, "No active standalone work may remain.");
  const unknownStandalone = id(72);
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status)
    values (${unknownStandalone},${organization},${dmA},${a},'Unknown standalone','unknown')`;
  await refuses(() => settle(), "explicit operator reconciliation");
  assert(Number(actions.length) === 2, "Unknown standalone must not trigger another mutation.");
  await owner`update runs set status='failed', ended_at=now() where id=${unknownStandalone}`;

  // FK ON DELETE SET NULL is real: a deleted member must never vanish from
  // the ownership proof merely because the roster row cascaded away.
  const deletedWorkflow = id(51), deletedRoot = id(62), deletedMember = id(63);
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status)
    values (${deletedRoot},${organization},${groupThread},${a},'Deleted member root','unknown')`;
  await owner`insert into workflows (id,organization_id,thread_id,root_run_id,root_bot_id,kind,status)
    values (${deletedWorkflow},${organization},${groupThread},${deletedRoot},${a},'group','unknown')`;
  await owner`update runs set workflow_id=${deletedWorkflow} where id=${deletedRoot}`;
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status,workflow_id)
    values (${deletedMember},${organization},${groupThread},${b},'Deleted historical member','completed',${deletedWorkflow})`;
  await owner`delete from bots where id=${b}`;
  const anonymized = await store.workflow(deletedWorkflow);
  assert(anonymized?.runs.some((value) => value.id === deletedMember && value.botId === null && value.organizationId === null), "Deleted member must surface as unproven null ownership.");
  await refuses(() => settle(), "ownership"); assert(Number(actions.length) === 2, "Deleted member must block abandonment.");
  await owner`update workflows set root_bot_id=null where id=${deletedWorkflow}`;
  await refuses(() => settle(), "ownership");
  assert(await store.workflow(id(999)) === null, "Missing workflow must not fabricate ownership.");
  await owner`insert into runs (id,organization_id,thread_id,bot_id,input,status)
    values (${id(80)},${otherOrganization},${id(33)},${otherTenantBot},'Other tenant','unknown')`;
  const otherTargets = await store.targets(otherTenantBot);
  assert(otherTargets.length === 1 && otherTargets[0]?.organizationId === otherOrganization, "Other tenant identities must remain explicit.");
  await refuses(() => settle(otherTenantBot), "ownership"); assert(Number(actions.length) === 2, "Other tenant must never authorize cleanup.");
});
console.info("E2E cleanup SQL: owned group abandonment, persisted re-poll, foreign/caller/handoff/deleted owners and standalone child cancellation passed.");
