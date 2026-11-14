// Admission grace of a workflow that never started, on a real PostgreSQL
// (domain/workflow-admission.ts). The first two scenarios come from Anthony
// Ringard's PR #61; the others are the two defects its audit found, and the
// guards around them.
//
//   1. Never started, its execution deadline already passed, still inside the
//      grace: claimed, and the context the runner then reads (claimRun ->
//      readContext -> admitClaimedRun) carries the fresh budget, so the
//      deadline check right after does not fail the run.
//   2. A later step of the started workflow does not extend that budget.
//   3. A queued step of a STARTED workflow past its deadline (worker crash
//      before the Hermes create, continuation waiting for a slot) is not
//      claimed and expires: it must not stay queued for ever.
//   4. Never started for longer than the grace: expires.
//   5. A run whose lease already expired writes no budget.
import { withDisposablePostgres } from "./disposable-postgres";
import { claimRun } from "../../modules/execution/src/application/queue";
import { readContext } from "../../modules/execution/src/application/runner/context";
import { admitClaimedRun, workflowDeadlinePassed } from "../../modules/execution/src/application/runner/admission";
import { sweepExpiredRunsTx } from "../../modules/execution/src/application/queue-sweeps";
import { withRunReceiptJournal } from "../../modules/execution/src/application/run-receipts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const ORG = "91460000-0000-4000-8000-000000000001";
const BOT = "91460000-0000-4000-8000-000000000003";
const SECTION = "91460000-0000-4000-8000-000000000004";
const RUNTIME = "91460000-0000-4000-8000-000000000005";
const id = (n: number) => `91460000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const trace = { span: (_name: string, fn: () => unknown) => Promise.resolve(fn()) } as never;

await withDisposablePostgres("openedbot146_workflow_admission_grace", async ({ owner, connect }) => {
  await owner`insert into organizations (id, slug, name) values (${ORG}, 'admission-grace', 'Admission grace')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Grace', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position) values (${BOT}, ${ORG}, ${SECTION}, 'Grace', 'grace', 0)`;
  const linkHash = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_last_seen_at, link_token_hash)
    values (${RUNTIME}, ${ORG}, 'Fixture connector', 'connector', true, 8, now(), ${linkHash})`;
  const db = await connect("openedbot_worker");
  const config = { workerId: "admission-grace", billingEnforced: false, leaseSeconds: 30 } as never;

  /** A thread with one queued run in a workflow, every date relative to now. */
  async function queuedWorkflow(n: number, workflow: {
    timeoutSeconds: number; queuedMinutesAgo: number; startedMinutesAgo: number | null; deadlineInMinutes?: number;
  }): Promise<{ thread: string; run: string; workflow: string }> {
    const thread = id(100 + n);
    const run = id(10 + n);
    const workflowId = id(200 + n);
    const deadlineInMinutes = workflow.deadlineInMinutes
      ?? workflow.timeoutSeconds / 60 - workflow.queuedMinutesAgo;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${ORG}, ${BOT}, ${`Grace ${n}`}, ${`admission-grace-${n}`}, ${n === 1})`;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input)
      values (${run}, ${ORG}, ${thread}, ${BOT}, 'fixture')`;
    await owner`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind, status,
        timeout_seconds, created_at, started_at, deadline_at)
      values (${workflowId}, ${ORG}, ${thread}, ${run}, ${BOT}, 'dm',
        ${workflow.startedMinutesAgo === null ? "queued" : "running"}, ${workflow.timeoutSeconds},
        now() - (${workflow.queuedMinutesAgo} * interval '1 minute'),
        case when ${workflow.startedMinutesAgo}::integer is null then null
          else now() - (${workflow.startedMinutesAgo}::integer * interval '1 minute') end,
        now() + (${deadlineInMinutes} * interval '1 minute'))`;
    await owner`update runs set workflow_id = ${workflowId} where id = ${run}`;
    return { thread, run, workflow: workflowId };
  }

  // 1. Queued 35 min ago with a 30 min budget: deadline passed 5 min ago,
  //    still inside the 2 h grace. The runner's own path must keep it alive.
  const first = await queuedWorkflow(1, { timeoutSeconds: 1800, queuedMinutesAgo: 35, startedMinutesAgo: null });
  const claimed = await claimRun(db, config);
  assert(claimed?.id === first.run, "A workflow that never started must stay claimable inside its admission grace.");
  const context = await readContext(db, config, claimed);
  assert(context, "readContext must read the claimed run.");
  assert(workflowDeadlinePassed(context, Date.now()), "Before admission, the context holds the stale deadline (fixture check).");
  const client = await admitClaimedRun(db, config, context, trace);
  assert(client, "Admission must not fail the run.");
  assert(context.workflowStatus === "running", `The context must say running (got ${context.workflowStatus}).`);
  assert(!workflowDeadlinePassed(context, Date.now()),
    "After admission the context must carry the fresh budget: the deadline check that follows must not fail the run.");
  const remaining = new Date(context.workflowDeadlineAt!).getTime() - Date.now();
  assert(remaining > 1_700_000, `The fresh budget must be the whole 30 min (left: ${Math.round(remaining / 1000)} s).`);
  const [stored] = await owner<Array<{ deadline_at: Date; started_at: Date | null; status: string }>>`
    select deadline_at, started_at, status from workflows where id = ${first.workflow}`;
  assert(stored!.started_at !== null && stored!.status === "running", "The workflow must be started in the database.");
  assert(stored!.deadline_at.getTime() === new Date(context.workflowDeadlineAt!).getTime(),
    "The context and the database must hold the same deadline.");

  // 2. A later step of the started workflow does not extend the budget.
  const step = id(31);
  await owner`update runs set status = 'completed', external_state = 'settled', ended_at = now(),
      lease_owner = null, lease_expires_at = null where id = ${first.run}`;
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input, workflow_id, step_index)
    values (${step}, ${ORG}, ${first.thread}, ${BOT}, 'continuation', ${first.workflow}, 1)`;
  const claimedStep = await claimRun(db, config);
  assert(claimedStep?.id === step, "The next step of the started workflow must be claimable before its deadline.");
  const stepContext = await readContext(db, config, claimedStep);
  assert(stepContext && await admitClaimedRun(db, config, stepContext, trace), "The step must be admitted.");
  const [afterStep] = await owner<Array<{ deadline_at: Date }>>`select deadline_at from workflows where id = ${first.workflow}`;
  assert(afterStep!.deadline_at.getTime() === stored!.deadline_at.getTime(),
    "A step of a started workflow must never extend its deadline.");
  await owner`update runs set status = 'completed', external_state = 'settled', ended_at = now(),
      lease_owner = null, lease_expires_at = null where id = ${step}`;
  await owner`update workflows set status = 'completed', ended_at = now() where id = ${first.workflow}`;

  // 3. Started 50 min ago, deadline passed 20 min ago, one step still queued
  //    and never sent to Hermes. Before the fix of the audit it stayed queued.
  const stuck = await queuedWorkflow(3, { timeoutSeconds: 1800, queuedMinutesAgo: 50, startedMinutesAgo: 50, deadlineInMinutes: -20 });
  assert((await claimRun(db, config)) === null, "A queued step of a started workflow past its deadline must not be claimed.");
  await withRunReceiptJournal(db, (tx) => sweepExpiredRunsTx(tx));
  const [stuckRun] = await owner<Array<{ status: string; error_code: string | null }>>`
    select status, error_code from runs where id = ${stuck.run}`;
  const [stuckWorkflow] = await owner<Array<{ status: string }>>`select status from workflows where id = ${stuck.workflow}`;
  assert(stuckRun!.status === "failed" && stuckRun!.error_code === "WORKFLOW_DEADLINE_EXCEEDED",
    `A queued step of a started workflow past its deadline must expire (run: ${stuckRun!.status}).`);
  assert(stuckWorkflow!.status === "expired", `Its workflow must expire too (got ${stuckWorkflow!.status}).`);

  // 4. Queued 125 min ago and never started: past the 2 h grace, expires.
  const late = await queuedWorkflow(4, { timeoutSeconds: 1800, queuedMinutesAgo: 125, startedMinutesAgo: null });
  assert((await claimRun(db, config)) === null, "A workflow queued past its grace must not be claimed.");
  await withRunReceiptJournal(db, (tx) => sweepExpiredRunsTx(tx));
  const [lateWorkflow] = await owner<Array<{ status: string; error_code: string | null }>>`
    select status, error_code from workflows where id = ${late.workflow}`;
  const [lateRun] = await owner<Array<{ status: string }>>`select status from runs where id = ${late.run}`;
  assert(lateWorkflow!.status === "expired" && lateWorkflow!.error_code === "WORKFLOW_DEADLINE_EXCEEDED",
    `A workflow queued past its grace must expire (got ${lateWorkflow!.status}).`);
  assert(lateRun!.status === "failed", `Its run must be settled, not left queued (got ${lateRun!.status}).`);

  // 5. Never started, inside the grace, but the lease of the claiming worker
  //    expired before the admission: no fresh budget is written.
  const fenced = await queuedWorkflow(5, { timeoutSeconds: 1800, queuedMinutesAgo: 35, startedMinutesAgo: null });
  const claimedFenced = await claimRun(db, config);
  assert(claimedFenced?.id === fenced.run, "The fifth workflow must be claimable.");
  const fencedContext = await readContext(db, config, claimedFenced);
  assert(fencedContext, "readContext must read the fifth run.");
  await owner`update runs set lease_expires_at = now() - interval '1 second' where id = ${fenced.run}`;
  await admitClaimedRun(db, config, fencedContext, trace);
  const [fencedWorkflow] = await owner<Array<{ started_at: Date | null; deadline_at: Date }>>`
    select started_at, deadline_at from workflows where id = ${fenced.workflow}`;
  assert(fencedWorkflow!.started_at === null, "An expired lease must not start the workflow.");
  assert(fencedWorkflow!.deadline_at.getTime() < Date.now(), "An expired lease must not write a fresh budget.");

  console.info(JSON.stringify({ event: "workflow_admission_grace.passed", scenarios: 5 }));
});
