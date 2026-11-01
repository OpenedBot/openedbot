/**
 * PERM2-11 (DEV-OHB-262), tenant side, against a disposable PostgreSQL
 * database: the decision journal (`GET /decisions`, `listDecisions`) says
 * who or what decided each gate and why. A gate the grant answered shows
 * the grant and its author (by the id the worker records, or for an older
 * row the grant active at the answer); a refusal the floor held shows the
 * rule; the terminal switch shows who turned it on; nothing of another
 * tenant, of the gate arguments, the description or the reviewer's words
 * crosses. Human decisions stay the signed chain; policy decisions are a
 * projection next to it.
 */
import type { SQL } from "bun";
import type { DecisionDto } from "@openedbot/contracts-api";
import { appendDecisionTx } from "../../modules/execution/src/application/decision-journal";
import { listDecisions } from "../../apps/api/src/interfaces/http/misc-routes";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `a2621100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id(10);
const ORG_B = id(20);
const MEMBER = id(1);
const OTHER = id(2);
const BOT_A = id(13);
const BOT_B = id(23);
const THREAD_A = id(15);
const THREAD_B = id(25);
const RUN_A = id(16);
const RUN_B = id(26);
const RUNTIME_A = id(12);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function asTenant<T>(sql: SQL, organizationId: string, run: (tx: Bun.TransactionSQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

await withDisposablePostgres("ohb262_decision_trace", async ({ owner, connect }) => {
  const api = await connect("ohb_api");

  await owner`insert into users (id, email, display_name) values
    (${MEMBER}, 'camille.lefevre@example.com', 'Camille Lefèvre'),
    (${OTHER}, 'other@example.com', 'Tenant B Author')`;
  for (const [org, slug, section, bot, thread, run, user] of [
    [ORG_A, "acme", id(11), BOT_A, THREAD_A, RUN_A, MEMBER],
    [ORG_B, "acme-b", id(21), BOT_B, THREAD_B, RUN_B, OTHER],
  ] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Acme', 'v2')`;
    await owner`insert into memberships (organization_id, user_id, role) values (${org}, ${user}, 'owner')`;
    await owner`insert into sections (id, organization_id, name, position) values (${section}, ${org}, 'Bots', 0)`;
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${bot}, ${org}, ${section}, 'Scout', 'scout', 0, 'auto')`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${org}, ${bot}, 'DM', ${`trace-${thread}`}, true)`;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status)
      values (${run}, ${org}, ${thread}, ${bot}, 'Trace run', 'completed')`;
  }
  await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, capacity)
    values (${RUNTIME_A}, ${ORG_A}, 'Connector', 'connector', ${RUNTIME_A.replaceAll("-", "").padEnd(64, "0")}, true, 4)`;

  const gate = (input: {
    n: number; org: string; thread: string; run: string; ordinal: number; age: string; status: string; choice: string;
    resolvedBy: string | null; policy: string | null; kind: string; toolKey: string | null;
    stage: string; decidedBy: string; detail: unknown;
  }) => owner`
    insert into approval_requests (
      id, organization_id, thread_id, run_id, gate_ordinal, command, description, choices, expires_at, created_at,
      status, selected_choice, resolved_at, resolved_by, resolved_by_policy, forwarded_at,
      gate_kind, tool_key, gate_args, descriptor_version,
      decision_state, decision_stage, decided_by_kind, permission_revision_seen, decision_detail
    ) values (
      ${id(input.n)}, ${input.org}, ${input.thread}, ${input.run}, ${input.ordinal}, ${`gate ${input.n}`}, 'secret description',
      ${["once", "deny"]}, now() + interval '10 minutes', now() - ${input.age}::interval,
      ${input.status}, ${input.choice}, now() - ${input.age}::interval, ${input.resolvedBy}, ${input.policy}, now(),
      ${input.kind}, ${input.toolKey}, ${input.kind === "plugin_tool" ? { path: "secret/args.md" } : { command: "secret command" }},
      ${input.kind === "plugin_tool" ? 1 : null},
      'decided', ${input.stage}, ${input.decidedBy}, 3, ${input.detail}
    )`;
  const a = { org: ORG_A, thread: THREAD_A, run: RUN_A };
  const plugin = { kind: "plugin_tool", toolKey: "write_file" };
  const terminal = { kind: "terminal_danger", toolKey: null };

  // 71: a member answered "Always" on a deletion gate; the grant it recorded comes from it.
  await gate({ n: 71, ...a, ordinal: 0, age: "60 minutes", status: "approved", choice: "once", resolvedBy: MEMBER, policy: null, ...plugin,
    stage: "deletion", decidedBy: "member", detail: { reason: "deletion", always: "always_bot_tool" } });
  const grant = (await owner<Array<{ id: string }>>`
    insert into bot_permission_grants (organization_id, bot_id, tool_key, created_by_user_id, created_by_kind, created_from_approval_id, created_at)
    values (${ORG_A}, ${BOT_A}, 'write_file', ${MEMBER}, 'member', ${id(71)}, now() - interval '59 minutes') returning id`)[0]!.id;
  await owner`update approval_requests set decision_detail = decision_detail || ${{ grantId: grant }}::jsonb where id = ${id(71)}`;
  await asTenant(api, ORG_A, (tx) => appendDecisionTx(tx, {
    organizationId: ORG_A, threadId: THREAD_A, runId: RUN_A, approvalRequestId: id(71), actorUserId: MEMBER, choice: "once",
    envelope: { version: 1, organizationId: ORG_A, approvalRequestId: id(71), threadId: THREAD_A, runId: RUN_A, actorUserId: MEMBER,
      choice: "once", occurredAt: new Date().toISOString(), botId: BOT_A, botName: "Scout", action: "gate 71", kind: "shell", grantId: grant },
  }));
  // 72: the grant answered the next gate, and the worker recorded its id.
  await gate({ n: 72, ...a, ordinal: 1, age: "50 minutes", status: "approved", choice: "once", resolvedBy: null, policy: "auto", ...plugin,
    stage: "grant", decidedBy: "policy", detail: { reason: "grant", effectiveMode: "auto", grantId: grant } });
  // 73: an older grant answer, without the id: the grant active at the answer is found.
  await gate({ n: 73, ...a, ordinal: 2, age: "40 minutes", status: "approved", choice: "once", resolvedBy: null, policy: "auto", ...plugin,
    stage: "grant", decidedBy: "policy", detail: { reason: "grant", effectiveMode: "auto" } });
  // 74: the floor held a sensitive path, and the member refused it.
  await gate({ n: 74, ...a, ordinal: 3, age: "30 minutes", status: "denied", choice: "deny", resolvedBy: MEMBER, policy: null, ...plugin,
    stage: "floor", decidedBy: "member", detail: { reason: "sensitive_path", effectiveMode: "auto" } });
  await asTenant(api, ORG_A, (tx) => appendDecisionTx(tx, {
    organizationId: ORG_A, threadId: THREAD_A, runId: RUN_A, approvalRequestId: id(74), actorUserId: MEMBER, choice: "deny",
    envelope: { version: 1, organizationId: ORG_A, approvalRequestId: id(74), threadId: THREAD_A, runId: RUN_A, actorUserId: MEMBER,
      choice: "deny", occurredAt: new Date().toISOString(), botId: BOT_A, botName: "Scout", action: "gate 74", kind: "shell" },
  }));
  // 75: the runtime switch answered a dangerous command; Camille turned it on before.
  await owner`insert into runtime_permission_settings (runtime_id, organization_id, terminal_danger_always, updated_by_user_id, updated_by_kind, updated_at)
    values (${RUNTIME_A}, ${ORG_A}, true, ${MEMBER}, 'member', now() - interval '25 minutes')`;
  await gate({ n: 75, ...a, ordinal: 4, age: "20 minutes", status: "approved", choice: "once", resolvedBy: null, policy: "auto", ...terminal,
    stage: "grant", decidedBy: "policy", detail: { reason: "terminal_switch", effectiveMode: "auto" } });
  // 76: nobody answers this routine; the floor would have held the gate.
  await gate({ n: 76, ...a, ordinal: 5, age: "10 minutes", status: "denied", choice: "deny", resolvedBy: null, policy: "manual", ...terminal,
    stage: "unattended", decidedBy: "policy", detail: { reason: "never_wait", heldStage: "floor", heldReason: "circuit_breaker" } });
  // 77: the reviewer refused, in its own words that the journal does not carry.
  await gate({ n: 77, ...a, ordinal: 6, age: "5 minutes", status: "denied", choice: "deny", resolvedBy: null, policy: "auto", ...plugin,
    stage: "review", decidedBy: "policy", detail: { reason: "review_deny", reviewerReason: "secret reviewer words", durationMs: 1200 } });
  // Tenant B: a grant answer of its own, by its own author.
  const grantB = (await owner<Array<{ id: string }>>`
    insert into bot_permission_grants (organization_id, bot_id, tool_key, created_by_user_id, created_by_kind, created_at)
    values (${ORG_B}, ${BOT_B}, 'write_file', ${OTHER}, 'member', now() - interval '2 hours') returning id`)[0]!.id;
  await gate({ n: 81, org: ORG_B, thread: THREAD_B, run: RUN_B, ordinal: 0, age: "15 minutes", status: "approved", choice: "once",
    resolvedBy: null, policy: "auto", ...plugin, stage: "grant", decidedBy: "policy", detail: { reason: "grant", grantId: grantB } });
  // A tenant A gate pointing at tenant B's grant id never shows it.
  await gate({ n: 78, ...a, ordinal: 7, age: "4 minutes", status: "approved", choice: "once", resolvedBy: null, policy: "auto", ...plugin,
    stage: "grant", decidedBy: "policy", detail: { reason: "grant", grantId: grantB } });

  const decisions = await asTenant(api, ORG_A, (tx) => listDecisions(tx, ORG_A));
  const byGate = (n: number, origin: DecisionDto["origin"]) =>
    decisions.find((d) => (origin === "policy" ? d.id === id(n) : d.origin === "human" && d.action === `gate ${n}`));

  // 1. Only tenant A, each gate once: human ones from the signed chain, policy ones projected.
  assert(decisions.length === 8, `unexpected rows: ${JSON.stringify(decisions.map((d) => [d.origin, d.action]))}`);
  assert(!decisions.some((d) => d.id === id(81)), "tenant B's gate crossed");

  // 2. A gate the grant answered shows the grant and its author, from "Always".
  const byGrant = byGate(72, "policy");
  assert(byGrant?.trace?.stage === "grant" && byGrant.trace.decidedBy === "policy" && byGrant.trace.reason === "grant"
    && byGrant.trace.grant?.kind === "bot_tool" && byGrant.trace.grant.authorName === "Camille Lefèvre"
    && byGrant.trace.grant.authorKind === "member" && byGrant.trace.grant.fromAlways && !byGrant.trace.grant.revoked,
    `unexpected grant answer: ${JSON.stringify(byGrant)}`);
  const older = byGate(73, "policy");
  assert(older?.trace?.grant?.authorName === "Camille Lefèvre" && older.trace.grant.fromAlways, `the older grant answer lost its grant: ${JSON.stringify(older)}`);
  const foreign = byGate(78, "policy");
  assert(foreign?.trace?.stage === "grant" && foreign.trace.grant === null, `another tenant's grant crossed: ${JSON.stringify(foreign)}`);

  // 3. The floor's refusal shows the rule and the person who answered.
  const floor = byGate(74, "human");
  assert(floor?.choice === "deny" && floor.entryHash && floor.trace?.stage === "floor" && floor.trace.reason === "sensitive_path"
    && floor.trace.decidedBy === "member" && floor.trace.deciderName === "Camille Lefèvre", `unexpected floor answer: ${JSON.stringify(floor)}`);
  const always = byGate(71, "human");
  assert(always?.trace?.always?.choice === "always_bot_tool" && always.trace.always.saved && always.trace.reason === "deletion",
    `unexpected Always answer: ${JSON.stringify(always)}`);

  // 4. The runtime switch names who turned it on; unattended says what held it.
  const switched = byGate(75, "policy");
  assert(switched?.trace?.grant?.kind === "runtime_terminal" && switched.trace.grant.authorName === "Camille Lefèvre"
    && !switched.trace.grant.revoked, `unexpected switch answer: ${JSON.stringify(switched)}`);
  const unattended = byGate(76, "policy");
  assert(unattended?.policy === "manual" && unattended.trace?.stage === "unattended" && unattended.trace.heldBy?.stage === "floor"
    && unattended.trace.heldBy.reason === "circuit_breaker", `unexpected unattended answer: ${JSON.stringify(unattended)}`);
  const review = byGate(77, "policy");
  assert(review?.trace?.reason === "review_deny", `unexpected review answer: ${JSON.stringify(review)}`);

  // 5. Switched off since: the author of the old answer is no longer told, the switch says it is off.
  await owner`update runtime_permission_settings set terminal_danger_always = false, updated_at = now() where runtime_id = ${RUNTIME_A}`;
  const later = (await asTenant(api, ORG_A, (tx) => listDecisions(tx, ORG_A))).find((d) => d.id === id(75));
  assert(later?.trace?.grant?.kind === "runtime_terminal" && later.trace.grant.authorName === null && later.trace.grant.revoked,
    `unexpected switch after it was turned off: ${JSON.stringify(later)}`);

  const raw = JSON.stringify(decisions);
  assert(!raw.includes("secret") && !raw.includes("Tenant B Author"), "gate arguments, description, reviewer words or another tenant crossed");

  // 6. The origin filter still splits the signed chain from the projection.
  const human = await asTenant(api, ORG_A, (tx) => listDecisions(tx, ORG_A, { origin: "human" }));
  assert(human.length === 2 && human.every((d) => d.origin === "human" && d.entryHash), "the human filter let a policy row through");
});

console.log("decision trace: grant and author, floor rule, switch author, unattended hold; tenant-scoped, codes only");
