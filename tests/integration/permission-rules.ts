/**
 * PERM2-6 (DEV-OHB-256) against a disposable PostgreSQL database: the
 * natural-language permission rules of 0145. The API writes its own tenant
 * only, through the real use cases; every write raises the revision of the
 * bots it concerns (the bot, or every bot of the organization) and of no
 * other; the cap of 20 per (scope, kind) holds on every insert path and
 * under concurrency; an organization rule is only a live owner's or admin's;
 * the worker reads one organization at a time under the tenant setting it
 * sets and restores, never without it, and writes nothing; the reviewer is
 * given the rules the organization's `rules_mode` selects, fenced.
 */
import type { SQL } from "bun";
import type { Db } from "@openedbot/platform-db";
import { addPermissionRule, readPermissionRulesView, removePermissionRule } from "../../modules/roster/src/application/permission-rules";
import { readReviewRulesTx } from "../../modules/roster/src/sql/permission-rules";
import { claimReviewGates, readReviewRules, reviewGate, type ReviewDeps } from "../../modules/execution/src/application/approval-review";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92560000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id(1);
const ORG_B = id(2);
const AGENCY = id(3);
const LEGACY = id(5);
const OWNER = id(11);
const MEMBER = id(12);
const BOT_A1 = id(21);
const BOT_A2 = id(22);
const BOT_B = id(23);
const BOT_LEGACY = id(24);
const RUNTIME = id(31);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function asTenant<T>(sql: SQL, organizationId: string, run: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return run(tx as unknown as SQL);
  }) as Promise<T>;
}

async function failure(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; } catch (error) {
    const details = error as { code?: unknown; errno?: unknown; message?: unknown };
    // Bun puts the SQLSTATE in `errno`; an HttpError carries its code in `code`.
    return String(details.errno ?? details.code ?? details.message ?? "error");
  }
}

await withDisposablePostgres("ohb256_permission_rules", async ({ owner, connect }) => {
  const api = await connect("ohb_api");
  const api2 = await connect("ohb_api");
  const worker = await connect("ohb_worker");
  await owner`insert into users (id, email) values (${OWNER}, 'camille.lefevre@example.com'), (${MEMBER}, 'member@example.com')`;
  for (const [org, slug, pipeline] of [[ORG_A, "acme", "v2"], [ORG_B, "acme-other", "v2"], [AGENCY, "acme-agency", "v2"], [LEGACY, "acme-legacy", "legacy"]] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Acme', ${pipeline})`;
  }
  await owner`insert into memberships (organization_id, user_id, role) values
    (${ORG_A}, ${OWNER}, 'owner'), (${ORG_A}, ${MEMBER}, 'member'), (${ORG_B}, ${OWNER}, 'owner'), (${LEGACY}, ${OWNER}, 'owner')`;
  let section = 40;
  for (const [org, bot, slug] of [[ORG_A, BOT_A1, "scout"], [ORG_A, BOT_A2, "scribe"], [ORG_B, BOT_B, "scout"], [LEGACY, BOT_LEGACY, "scout"]] as const) {
    const sectionId = id(section++);
    await owner`insert into sections (id, organization_id, name, position) values (${sectionId}, ${org}, 'Bots', ${section})`;
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${bot}, ${org}, ${sectionId}, 'Scout', ${slug}, 0, 'auto')`;
  }
  const revision = async (bot: string) => Number((await owner<Array<{ r: string }>>`select permission_revision as r from bots where id = ${bot}`)[0]!.r);
  const member = { userId: OWNER, kind: "member" as const, agencyOrganizationId: null };
  const apiDb = api as unknown as Db;

  // 1. A bot rule raises its bot only; an organization rule every bot of the organization.
  const [a1, a2, b] = [await revision(BOT_A1), await revision(BOT_A2), await revision(BOT_B)];
  const botView = await addPermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A1 }, member, { kind: "allow", text: "Edit files in docs" });
  assert(botView.rules.length === 1 && botView.scope === "bot" && botView.enforced, `unexpected bot view: ${JSON.stringify(botView)}`);
  assert(await revision(BOT_A1) === a1 + 1 && await revision(BOT_A2) === a2, "a bot rule did not raise its bot only");
  const orgView = await addPermissionRule(apiDb, { organizationId: ORG_A, botId: null }, member, { kind: "ask_first", text: "Anything with payments" });
  assert(orgView.rules.length === 1 && orgView.scope === "organization", `unexpected organization view: ${JSON.stringify(orgView)}`);
  assert(await revision(BOT_A1) === a1 + 2 && await revision(BOT_A2) === a2 + 1, "an organization rule did not raise every bot");
  assert(await revision(BOT_B) === b, "another organization's bot moved");
  const removed = botView.rules[0]!.id;
  await removePermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A1 }, removed);
  assert(await revision(BOT_A1) === a1 + 3, "removing a rule did not raise the revision");
  assert(await failure(() => removePermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A1 }, removed)) === "PERMISSION_RULE_NOT_FOUND", "a gone rule was removed twice");
  assert(await failure(() => removePermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A1 }, orgView.rules[0]!.id)) === "PERMISSION_RULE_NOT_FOUND",
    "a bot route removed an organization rule");
  assert(await failure(() => addPermissionRule(apiDb, { organizationId: LEGACY, botId: BOT_LEGACY }, member, { kind: "allow", text: "x" })) === "PERMISSION_RULES_REQUIRE_V2",
    "a legacy organization accepted a rule");

  // 2. The cap: 20 per (scope, kind), through the use case, then directly past it.
  for (let index = 0; index < 20; index += 1) {
    await addPermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A1 }, member, { kind: "allow", text: `Allow rule ${index}` });
  }
  assert(await failure(() => addPermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A1 }, member, { kind: "allow", text: "One more" })) === "PERMISSION_RULES_LIMIT",
    "the use case accepted a twenty-first rule");
  assert(await failure(() => owner`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
    values (${ORG_A}, ${BOT_A1}, 'allow', 'Straight to the table', ${OWNER}, 'member')`) === "23514", "the trigger let a twenty-first rule through");
  await addPermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A1 }, member, { kind: "ask_first", text: "Sending email" });
  await addPermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A2 }, member, { kind: "allow", text: "Allow rule 0" });

  // 3. Concurrency: two additions of the twentieth rule, one wins.
  for (let index = 0; index < 19; index += 1) {
    await addPermissionRule(apiDb, { organizationId: ORG_B, botId: BOT_B }, member, { kind: "allow", text: `Rule ${index}` });
  }
  let releaseFirst: () => void = () => {};
  const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstInserted: () => void = () => {};
  const inserted = new Promise<void>((resolve) => { firstInserted = resolve; });
  const first = asTenant(api, ORG_B, async (tx) => {
    await tx`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
      values (${ORG_B}, ${BOT_B}, 'allow', 'Racer one', ${OWNER}, 'member')`;
    firstInserted();
    await firstHolds;
  });
  await inserted;
  const second = failure(() => asTenant(api2, ORG_B, (tx) => tx`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
    values (${ORG_B}, ${BOT_B}, 'allow', 'Racer two', ${OWNER}, 'member')`));
  await Bun.sleep(300);
  releaseFirst();
  await first;
  assert(await second === "23514", "a concurrent twenty-first rule was not refused by the cap");
  const raced = Number((await owner<Array<{ n: string }>>`select count(*) as n from bot_permission_rules where bot_id = ${BOT_B} and kind = 'allow'`)[0]!.n);
  assert(raced === 20, `the race left ${raced} rules`);

  // 4. Constraints: duplicate case ignored in a scope, kinds, text form, organization actor.
  for (const [name, run] of [
    ["duplicate across kinds, case ignored", () => owner`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
      values (${ORG_A}, ${BOT_A2}, 'ask_first', 'ALLOW RULE 0', ${OWNER}, 'member')`],
    ["unknown kind", () => owner`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
      values (${ORG_A}, ${BOT_A2}, 'deny', 'x', ${OWNER}, 'member')`],
    ["two lines", () => owner`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
      values (${ORG_A}, ${BOT_A2}, 'allow', ${"a\nb"}, ${OWNER}, 'member')`],
    ["too long", () => owner`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
      values (${ORG_A}, ${BOT_A2}, 'allow', ${"x".repeat(1_001)}, ${OWNER}, 'member')`],
    ["agency organization rule", () => owner`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind, created_by_agency_organization_id)
      values (${ORG_A}, null, 'allow', 'From an agency', ${OWNER}, 'agency', ${AGENCY})`],
    ["organization rule by a plain member", () => owner`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
      values (${ORG_A}, null, 'allow', 'From a member', ${MEMBER}, 'member')`],
  ] as const) {
    assert(await failure(run) !== null, `the schema accepted: ${name}`);
  }
  // The same text in another scope is not a duplicate.
  await addPermissionRule(apiDb, { organizationId: ORG_A, botId: BOT_A2 }, member, { kind: "allow", text: "Anything with payments" });

  // 5. Tenant isolation on the API side; no UPDATE at all.
  assert((await asTenant(api, ORG_B, (tx) => tx`select 1 from bot_permission_rules where organization_id = ${ORG_A}`)).length === 0, "the API read another tenant's rules");
  assert(await failure(() => asTenant(api, ORG_B, (tx) => tx`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
    values (${ORG_A}, ${BOT_A1}, 'allow', 'Cross tenant', ${OWNER}, 'member')`)) !== null, "the API wrote into another tenant");
  assert(await failure(() => addPermissionRule(apiDb, { organizationId: ORG_B, botId: BOT_A1 }, member, { kind: "allow", text: "x" })) === "BOT_NOT_FOUND",
    "a write named a bot of another tenant");
  assert(await failure(() => asTenant(api, ORG_A, (tx) => tx`update bot_permission_rules set text = 'Changed' where organization_id = ${ORG_A}`)) !== null,
    "the API could edit a rule in place");
  assert((await readPermissionRulesView(apiDb, { organizationId: ORG_A, botId: BOT_A1 }, true)).rules.length === 21, "the API cannot read its own rules");

  // 6. The worker: one organization at a time, under the setting it restores; no write.
  assert((await worker`select 1 from bot_permission_rules`).length === 0, "the worker read rules without a tenant");
  const restored = await worker.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${ORG_B}, true)`;
    const rows = await readReviewRulesTx(tx as unknown as SQL, ORG_A, BOT_A2);
    const after = (await tx<Array<{ value: string }>>`select current_setting('app.organization_id', true) as value`)[0]!.value;
    return { rows, after };
  });
  assert(restored.after === ORG_B, "the worker did not restore its tenant setting");
  assert(restored.rows.length === 3 && restored.rows.filter((row) => row.scope === "organization").length === 1,
    `the worker read the wrong rules: ${JSON.stringify(restored.rows)}`);
  assert(await failure(() => asTenant(worker, ORG_A, (tx) => tx`delete from bot_permission_rules where organization_id = ${ORG_A}`)) !== null, "the worker could delete a rule");
  assert(await failure(() => asTenant(worker, ORG_A, (tx) => tx`insert into bot_permission_rules (organization_id, bot_id, kind, text, created_by_user_id, created_by_kind)
    values (${ORG_A}, ${BOT_A2}, 'allow', 'From the worker', ${OWNER}, 'member')`)) !== null, "the worker could add a rule");

  // 7. rules_mode: adds gives both scopes, replaces the organization's only.
  const texts = async () => (await readReviewRules(worker, ORG_A, BOT_A2)).map((rule) => `${rule.kind}:${rule.text}`).sort();
  assert(JSON.stringify(await texts()) === JSON.stringify(["allow:Allow rule 0", "ask_first:Anything with payments"]),
    `adds (no policy) gave ${JSON.stringify(await texts())}`);
  const beforeMode = await revision(BOT_A2);
  await owner`insert into organization_permission_policies (organization_id, rules_mode) values (${ORG_A}, 'replaces')`;
  assert(await revision(BOT_A2) === beforeMode + 1, "changing rules_mode did not raise the revision");
  assert(JSON.stringify(await texts()) === JSON.stringify(["ask_first:Anything with payments"]), `replaces gave ${JSON.stringify(await texts())}`);
  assert((await readPermissionRulesView(apiDb, { organizationId: ORG_A, botId: BOT_A2 }, true)).rulesMode === "replaces", "the bot view hides the replacement");
  await owner`update organization_permission_policies set rules_mode = 'adds' where organization_id = ${ORG_A}`;

  // 8. The reviewer is given the rules, fenced; a bot of another organization sees none of them.
  await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, capacity, link_features)
    values (${RUNTIME}, ${ORG_A}, 'Connector', 'connector', ${"a".repeat(64)}, true, 4, '{profile_management,profile_capabilities,approval_policy}')`;
  await owner`insert into runtime_review_profiles (runtime_id, organization_id, status, proven_at) values (${RUNTIME}, ${ORG_A}, 'proven', now())`;
  const [thread, workflow, run, gate] = [id(101), id(102), id(103), id(104)];
  await owner.begin(async (tx) => {
    await tx`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${ORG_A}, ${BOT_A2}, 'Review', ${`review:${thread}`}, false)`;
    await tx`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind, status, autonomy_enabled)
      values (${workflow}, ${ORG_A}, ${thread}, ${run}, ${BOT_A2}, 'dm', 'running', true)`;
    await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind)
      values (${run}, ${ORG_A}, ${thread}, ${BOT_A2}, 'Mets à jour docs/notes.md', 'awaiting_approval', ${workflow}, 0, 'root')`;
    await tx`insert into approval_requests (
        id, organization_id, thread_id, run_id, gate_ordinal, command, description, choices, expires_at, status,
        gate_kind, tool_key, gate_args, descriptor_version, decision_state, decision_stage, permission_revision_seen, decision_detail
      ) values (${gate}, ${ORG_A}, ${thread}, ${run}, 0, null, 'Write docs/notes.md', '["once","deny"]'::jsonb, now() + interval '10 minutes', 'pending',
        'plugin_tool', 'write_file', ${{ tool: "write_file", deletes: "no", opaque: false, digest: "c".repeat(64), args: { path: "docs/notes.md", size: 12 } }},
        1, 'reviewing', 'review', 1, '{"reason":"review"}'::jsonb)`;
  });
  const job = (await claimReviewGates(worker, 8)).find((entry) => entry.id === gate);
  assert(job?.botId === BOT_A2, `the claim did not carry the run's bot: ${JSON.stringify(job?.botId)}`);
  const inputs: string[] = [];
  const clock = { now: Date.now() };
  const deps: ReviewDeps = {
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    client: () => ({
      mcpInventory: async () => ({ platform: "api_server", servers: [], catalog: [] }) as never,
      hostProfileInventory: async () => ({ profiles: [{ name: "ohb-reviewer", mcpServers: [] }] }) as never,
      createRun: async (input) => { inputs.push(input.input); return "review-run"; },
      getRunStatus: async () => ({ status: "completed", output: '{"verdict":"escalate","reason":"An ask first rule matches."}' }) as never,
      stopRun: async () => undefined,
      deleteSession: async () => undefined,
    }),
  };
  await reviewGate(worker as unknown as SQL, job, deps);
  const fenced = /<rules>\n([\s\S]*?)\n<\/rules>/.exec(inputs[0] ?? "");
  assert(fenced, "the reviewer input carries no rules block");
  const block = JSON.parse(fenced[1]!) as { ask_first: string[]; allow: string[] };
  assert(JSON.stringify(block) === JSON.stringify({ ask_first: ["Anything with payments"], allow: ["Allow rule 0"] }),
    `the reviewer was given ${JSON.stringify(block)}`);
  const decided = (await owner<Array<{ state: string; reason: string }>>`
    select decision_state as state, decision_detail->>'reason' as reason from approval_requests where id = ${gate}`)[0]!;
  assert(decided.state === "awaiting_human" && decided.reason === "review_escalated", `the escalation was not kept: ${JSON.stringify(decided)}`);
  assert((await readReviewRules(worker, ORG_B, BOT_A2)).length === 0, "a bot was read under another organization");

  // 9. Deleting the bot takes its rules; the organization's stay.
  await owner`delete from bots where id = ${BOT_A1}`;
  assert((await owner`select 1 from bot_permission_rules where bot_id = ${BOT_A1}`).length === 0, "a deleted bot kept its rules");
  assert((await owner`select 1 from bot_permission_rules where organization_id = ${ORG_A} and bot_id is null`).length === 1, "the organization lost its rules");

  console.log("PERM2-6 PostgreSQL proof passed: rules, revision, cap, concurrency, tenant isolation, worker read, rules mode, reviewer input.");
});
