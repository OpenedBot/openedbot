/**
 * PERM2-7 (DEV-OHB-258) against a disposable PostgreSQL database: the
 * reviewer loop on real rows, the model replaced by a scripted client. A gate
 * born `reviewing` is never offered to a human until the reviewer lets go;
 * the verdict is written once, under the claim token; every failure ends
 * with a human, and an escalation (only) moves the workflow, which notifies.
 */
import type { SQL } from "bun";
import { claimReviewGates, reviewGate, type ReviewDeps, type ReviewJob } from "../../modules/execution/src/application/approval-review";
import { HermesClientError } from "../../platform/hermes/src/index.ts";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92580000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const SECTION = id(2);
const RUNTIME = id(3);
const BOT = id(4);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Script = { output?: string; status?: "completed" | "failed"; mcpStale?: boolean; slowMs?: number; busy?: boolean };

function scriptedDeps(script: Script, clock: { now: number }): ReviewDeps & { inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    client: () => ({
      mcpInventory: async () => ({ platform: "api_server", servers: [{ name: "linear" }], catalog: [] }) as never,
      hostProfileInventory: async () => ({ profiles: [{ name: "ohb-reviewer", mcpServers: [{ name: "linear", enabled: script.mcpStale === true }] }] }) as never,
      createRun: async (input) => {
        if (script.busy) throw new HermesClientError("busy", 429, "HERMES_LIMIT_REACHED");
        inputs.push(input.input);
        return "review-run";
      },
      getRunStatus: async () => {
        if (script.slowMs) { clock.now += script.slowMs; return { status: "running" } as never; }
        return { status: script.status ?? "completed", output: script.output ?? null } as never;
      },
      stopRun: async () => undefined,
      deleteSession: async () => undefined,
    }),
  };
}

await withDisposablePostgres("ohb258_approval_review", async ({ owner, connect }) => {
  const worker = await connect("ohb_worker");
  await owner`insert into organizations (id, slug, name, permission_pipeline) values (${ORG}, 'acme-review', 'Acme', 'v2')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Review', 0)`;
  await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, capacity, link_features)
    values (${RUNTIME}, ${ORG}, 'Connector', 'connector', ${"a".repeat(64)}, true, 4, '{profile_management,profile_capabilities,approval_policy}')`;
  await owner`insert into runtime_review_profiles (runtime_id, organization_id, status, proven_at) values (${RUNTIME}, ${ORG}, 'proven', now())`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
    values (${BOT}, ${ORG}, ${SECTION}, 'Scout', 'scout', 0, 'auto')`;

  let next = 100;
  /** One thread, workflow, run and gate under review per scenario (one active run per thread). */
  async function reviewingGate(options: { ageMs?: number; priorReviewDenials?: number; neverWait?: boolean } = {}) {
    const thread = id(next++), workflow = id(next++), run = id(next++), gate = id(next++);
    await owner.begin(async (tx) => {
      await tx`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
        values (${thread}, ${ORG}, ${BOT}, 'Review', ${`review:${thread}`}, false)`;
      await tx`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind, status, autonomy_enabled, never_wait)
        values (${workflow}, ${ORG}, ${thread}, ${run}, ${BOT}, ${options.neverWait ? "routine" : "dm"}, 'running', true, ${options.neverWait === true})`;
      await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind)
        values (${run}, ${ORG}, ${thread}, ${BOT}, 'Écris le compte rendu dans notes.md', 'awaiting_approval', ${workflow}, 0, 'root')`;
      for (let index = 0; index < (options.priorReviewDenials ?? 0); index += 1) {
        await tx`insert into approval_requests (
            id, organization_id, thread_id, run_id, gate_ordinal, command, choices, expires_at, status, selected_choice,
            resolved_at, resolved_by_policy, forward_state, forwarded_at, decision_state, decision_stage, decided_by_kind,
            permission_revision_seen, decision_detail
          ) values (${id(next++)}, ${ORG}, ${thread}, ${run}, ${index}, null, '["once","deny"]'::jsonb, now() + interval '10 minutes',
            'denied', 'deny', now(), 'auto', 'confirmed', now(), 'decided', 'review', 'policy', 1, '{"reason":"review_deny"}'::jsonb)`;
      }
      await tx`insert into approval_requests (
          id, organization_id, thread_id, run_id, gate_ordinal, command, description, choices, expires_at, status,
          gate_kind, tool_key, gate_args, descriptor_version, decision_state, decision_stage, permission_revision_seen,
          decision_detail, created_at
        ) values (${gate}, ${ORG}, ${thread}, ${run}, ${options.priorReviewDenials ?? 0}, null, 'Write notes.md',
          '["once","deny"]'::jsonb, now() + interval '10 minutes', 'pending',
          'plugin_tool', 'write_file', ${{ tool: "write_file", deletes: "no", opaque: false, digest: "b".repeat(64), args: { path: "notes.md", size: 12 } }},
          1, 'reviewing', 'review', 1, '{"reason":"review","effectiveMode":"auto"}'::jsonb, now() - (${options.ageMs ?? 0} * interval '1 millisecond'))`;
    });
    return { thread, workflow, run, gate };
  }
  async function claimOne(gate: string): Promise<ReviewJob> {
    const jobs = await claimReviewGates(worker, 8);
    const job = jobs.find((entry) => entry.id === gate);
    assert(job, `gate ${gate} was not claimed`);
    return job;
  }
  const gateRow = async (gate: string) => (await owner<Array<{
    status: string; choice: string | null; state: string; kind: string | null; forward: string; detail: Record<string, unknown>; token: string | null;
  }>>`select status, selected_choice as choice, decision_state as state, decided_by_kind as kind, forward_state as forward,
            decision_detail as detail, decision_claim_token as token
       from approval_requests where id = ${gate}`)[0]!;
  const workflowStatus = async (workflow: string) => (await owner<Array<{ status: string }>>`select status from workflows where id = ${workflow}`)[0]!.status;
  const pushes = async (workflow: string) => Number((await owner<Array<{ n: number }>>`select count(*)::int as n from push_outbox where workflow_id = ${workflow}`)[0]!.n);

  // 1. Approve: `once` by the policy at stage `review`, ready to forward; no human, no notification.
  {
    const clock = { now: Date.now() };
    const fixture = await reviewingGate();
    const job = await claimOne(fixture.gate);
    assert((await claimReviewGates(worker, 8)).every((entry) => entry.id !== fixture.gate), "a claimed gate was claimed twice");
    const deps = scriptedDeps({ output: '{"verdict":"approve","reason":"Writes the notes the user asked for."}' }, clock);
    await reviewGate(worker as unknown as SQL, job, deps);
    const row = await gateRow(fixture.gate);
    assert(row.status === "approved" && row.choice === "once" && row.state === "decided" && row.kind === "policy" && row.forward === "ready" && row.token === null,
      `approve wrote ${JSON.stringify(row)}`);
    assert(row.detail.reviewerReason === "Writes the notes the user asked for.", "the reviewer reason was not kept");
    assert(deps.inputs[0]?.includes("notes.md") && deps.inputs[0].includes("<goal>"), "the reviewer did not see the gate and the goal");
    assert(await workflowStatus(fixture.workflow) === "running" && await pushes(fixture.workflow) === 0, "an approved review notified someone");
  }

  // 2. Deny: `deny` by the policy, ready to forward.
  {
    const clock = { now: Date.now() };
    const fixture = await reviewingGate();
    await reviewGate(worker as unknown as SQL, await claimOne(fixture.gate), scriptedDeps({ output: '{"verdict":"deny","reason":"Not asked."}' }, clock));
    const row = await gateRow(fixture.gate);
    assert(row.status === "denied" && row.choice === "deny" && row.forward === "ready", `deny wrote ${JSON.stringify(row)}`);
  }

  // 3. Every other ending is a human: escalate, prose, a failed run, a stale profile, a timeout, the budget spent, the circuit open.
  const humanCases: Array<{ name: string; script: Script; age?: number; denials?: number; reason: string; note?: string }> = [
    { name: "escalate", script: { output: '{"verdict":"escalate","reason":"Irreversible and not clearly asked."}' }, reason: "review_escalated", note: "Irreversible and not clearly asked." },
    { name: "prose", script: { output: "Looks fine to me!" }, reason: "review_unreadable" },
    { name: "failed run", script: { status: "failed" }, reason: "review_run_failed" },
    { name: "stale profile", script: { mcpStale: true, output: '{"verdict":"approve","reason":"ok"}' }, reason: "review_profile_stale" },
    { name: "slow model", script: { slowMs: 5_000 }, reason: "review_timeout" },
    { name: "no free run slot", script: { busy: true }, reason: "review_runtime_busy" },
    { name: "budget spent in the queue", script: { output: '{"verdict":"approve","reason":"ok"}' }, age: 16_000, reason: "review_timeout" },
    { name: "circuit", script: { output: '{"verdict":"approve","reason":"ok"}' }, denials: 3, reason: "review_circuit_open" },
  ];
  for (const scenario of humanCases) {
    const clock = { now: Date.now() };
    const fixture = await reviewingGate({ ageMs: scenario.age, priorReviewDenials: scenario.denials });
    await reviewGate(worker as unknown as SQL, await claimOne(fixture.gate), scriptedDeps(scenario.script, clock));
    const row = await gateRow(fixture.gate);
    assert(row.status === "pending" && row.state === "awaiting_human" && row.choice === null && row.forward === "pending",
      `${scenario.name}: expected a human, got ${JSON.stringify(row)}`);
    assert(row.detail.reason === scenario.reason, `${scenario.name}: reason ${String(row.detail.reason)}, expected ${scenario.reason}`);
    // The card offers "Always" from this mode: an escalation keeps it.
    assert(row.detail.effectiveMode === "auto", `${scenario.name}: the escalation dropped effectiveMode`);
    if (scenario.note) assert(row.detail.reviewerReason === scenario.note, `${scenario.name}: the escalation note was lost`);
    assert(await workflowStatus(fixture.workflow) === "awaiting_approval", `${scenario.name}: the workflow did not wait for the human`);
    assert(await pushes(fixture.workflow) === 1, `${scenario.name}: the human was not notified once`);
  }

  // 4. A stale claim writes nothing: the lease expired and another worker took the gate.
  {
    const clock = { now: Date.now() };
    const fixture = await reviewingGate();
    const first = await claimOne(fixture.gate);
    await owner`update approval_requests set decision_lease_expires_at = now() - interval '1 second' where id = ${fixture.gate}`;
    const second = await claimOne(fixture.gate);
    await reviewGate(worker as unknown as SQL, first, scriptedDeps({ output: '{"verdict":"approve","reason":"ok"}' }, clock));
    assert((await gateRow(fixture.gate)).state === "reviewing", "a stale claim wrote a verdict");
    await reviewGate(worker as unknown as SQL, second, scriptedDeps({ output: '{"verdict":"deny","reason":"No."}' }, clock));
    assert((await gateRow(fixture.gate)).choice === "deny", "the live claim could not write");
  }

  // 5. PERM2-9: on a "Never wait" routine workflow an escalation is a refusal,
  // nobody is notified and the workflow keeps running; a verdict is unchanged.
  for (const scenario of [humanCases[0]!, humanCases[2]!, humanCases[5]!]) {
    const clock = { now: Date.now() };
    const fixture = await reviewingGate({ neverWait: true });
    const job = await claimOne(fixture.gate);
    // The snapshot is read at write time, under the workflow lock, through the port.
    assert(job.workflowId === fixture.workflow, "the claim lost the run's workflow");
    await reviewGate(worker as unknown as SQL, job, scriptedDeps(scenario.script, clock));
    const row = await gateRow(fixture.gate);
    assert(row.status === "denied" && row.choice === "deny" && row.state === "decided" && row.kind === "policy" && row.forward === "ready",
      `never wait, ${scenario.name}: expected a refusal, got ${JSON.stringify(row)}`);
    assert(row.detail.reason === "never_wait" && row.detail.heldStage === "review" && row.detail.heldReason === scenario.reason,
      `never wait, ${scenario.name}: detail ${JSON.stringify(row.detail)}`);
    const stage = (await owner<Array<{ stage: string }>>`select decision_stage as stage from approval_requests where id = ${fixture.gate}`)[0]!.stage;
    assert(stage === "unattended", `never wait, ${scenario.name}: stage ${stage}`);
    assert(await workflowStatus(fixture.workflow) === "running" && await pushes(fixture.workflow) === 0,
      `never wait, ${scenario.name}: somebody was notified for a gate nobody answers`);
  }
  {
    const clock = { now: Date.now() };
    const fixture = await reviewingGate({ neverWait: true });
    await reviewGate(worker as unknown as SQL, await claimOne(fixture.gate), scriptedDeps({ output: '{"verdict":"approve","reason":"ok"}' }, clock));
    const row = await gateRow(fixture.gate);
    assert(row.choice === "once" && row.detail.reason === "review_approve", `never wait must not change an approval: ${JSON.stringify(row)}`);
  }

  // 6. Without a fresh proof, or back on legacy, nobody is asked.
  for (const [name, setup, reason] of [
    ["unproven", async () => owner`update runtime_review_profiles set status = 'failed', proven_at = null, failure_code = 'REVIEW_PROFILE_TOOLS_ACTIVE' where runtime_id = ${RUNTIME}`, "review_unavailable"],
    ["legacy", async () => owner`update organizations set permission_pipeline = 'legacy' where id = ${ORG}`, "review_pipeline_legacy"],
  ] as const) {
    const clock = { now: Date.now() };
    const fixture = await reviewingGate();
    await setup();
    const deps = scriptedDeps({ output: '{"verdict":"approve","reason":"ok"}' }, clock);
    await reviewGate(worker as unknown as SQL, await claimOne(fixture.gate), deps);
    const row = await gateRow(fixture.gate);
    assert(row.state === "awaiting_human" && row.detail.reason === reason && deps.inputs.length === 0, `${name}: ${JSON.stringify(row)}`);
  }

  console.log("PERM2-7 PostgreSQL proof passed: verdicts under the claim token, every failure ends with a human.");
});
