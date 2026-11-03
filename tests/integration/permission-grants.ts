/**
 * PERM2-4 (DEV-OHB-254) against a disposable PostgreSQL database (0140):
 * "Always for this tool on this bot" and the runtime terminal switch.
 * Proves the tenant RLS of both tables for the API, the worker's read-only
 * access scoped to its run's organization, the partial unique index (a
 * double click makes one grant), the `active -> revoked` transitions, the
 * revision bumps, the worker pipeline reading both, and the answer route
 * end to end: an "Always" answered `once`, and a grant that fails to save
 * still answering `once` with `decision_detail.grantError`.
 */
import type { SQL } from "bun";
import { Hono } from "hono";
import { activeGrantIdTx, createBotPermissionGrantTx, revokeBotPermissionGrantTx } from "../../modules/roster/src/sql/permission-grants";
import { readTerminalAlwaysTx, setTerminalDangerAlwaysTx } from "../../modules/runtimes/src/sql/permission-settings";
import { resolveGateTx } from "../../modules/execution/src/application/runner/permission-gate";
import type { GateIdentity } from "../../modules/execution/src/domain/gate-identity";
import { approvalRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92540000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = id(1);
const ORG_A = id(10);
const ORG_B = id(20);
const SECTION_A = id(11);
const SECTION_B = id(21);
const RUNTIME_A = id(12);
const RUNTIME_B = id(22);
const BOT_A1 = id(13);
const BOT_A2 = id(14);
const BOT_B1 = id(23);
const THREAD_A = id(15);
const MEMBER = { userId: USER, kind: "member" as const, agencyOrganizationId: null };

const WRITE_ARGS = { tool: "write_file", deletes: "no", opaque: false, digest: "a".repeat(64), args: { path: "notes.md", size: 4 } };
const WRITE_GATE: GateIdentity = { hermesRequestId: "req-1", gateKind: "plugin_tool", toolKey: "write_file", gateArgs: WRITE_ARGS, descriptorVersion: 1 };
const TERMINAL_GATE: GateIdentity = { hermesRequestId: "req-2", gateKind: "terminal_danger", toolKey: null, gateArgs: { command: "git push --force" }, descriptorVersion: null };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function asTenant<T>(sql: SQL, organizationId: string, run: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${organizationId}, true)`;
    return run(tx as unknown as SQL);
  }) as Promise<T>;
}

async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as { errno?: string; code?: string }).errno ?? (error as Error).message;
  }
  return "accepted";
}

await withDisposablePostgres("ohb254_grants", async ({ owner, connect }) => {
  const worker = await connect("ohb_worker");
  const api = await connect("ohb_api");
  const revision = async (bot: string) => Number((await owner<Array<{ r: string }>>`select permission_revision as r from bots where id = ${bot}`)[0]!.r);

  await owner`insert into users (id, email) values (${USER}, 'camille.lefevre@example.com')`;
  for (const [org, slug, section, runtime] of [[ORG_A, "acme", SECTION_A, RUNTIME_A], [ORG_B, "acme-b", SECTION_B, RUNTIME_B]] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Acme', 'v2')`;
    await owner`insert into memberships (organization_id, user_id, role) values (${org}, ${USER}, 'owner')`;
    await owner`insert into sections (id, organization_id, name, position) values (${section}, ${org}, 'PERM2', 0)`;
    await owner`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, capacity)
      values (${runtime}, ${org}, 'Connector', 'connector', ${runtime.replaceAll("-", "").padEnd(64, "0")}, true, 4)`;
    // The review profile is proven, so `auto` stays `auto` (PERM2-7a).
    await owner`insert into runtime_review_profiles (runtime_id, organization_id, status, proven_at) values (${runtime}, ${org}, 'proven', now())`;
  }
  for (const [bot, org, section, slug] of [[BOT_A1, ORG_A, SECTION_A, "scout"], [BOT_A2, ORG_A, SECTION_A, "atlas"], [BOT_B1, ORG_B, SECTION_B, "scout"]] as const) {
    await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode)
      values (${bot}, ${org}, ${section}, ${slug}, ${slug}, 0, 'auto')`;
  }
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${THREAD_A}, ${ORG_A}, ${BOT_A1}, 'DM', 'perm2-grants', true)`;

  // 1. A grant raises its bot's revision only; a second create returns the same row and moves nothing.
  const [a1, a2, b1] = [await revision(BOT_A1), await revision(BOT_A2), await revision(BOT_B1)];
  const first = await asTenant(api, ORG_A, (tx) => createBotPermissionGrantTx(tx, { organizationId: ORG_A, botId: BOT_A1, toolKey: "write_file", actor: MEMBER, approvalId: null }));
  assert(first.created, "the first grant was not created");
  assert(await revision(BOT_A1) === a1 + 1 && await revision(BOT_A2) === a2 && await revision(BOT_B1) === b1, "a grant bumped the wrong revisions");
  const again = await asTenant(api, ORG_A, (tx) => createBotPermissionGrantTx(tx, { organizationId: ORG_A, botId: BOT_A1, toolKey: "write_file", actor: MEMBER, approvalId: null }));
  assert(again.id === first.id && !again.created && await revision(BOT_A1) === a1 + 1, "a repeated grant made a new row or moved the revision");

  // 2. The partial unique index: never two active grants for one (bot, tool), even concurrently.
  const duplicate = await refused(() => owner`insert into bot_permission_grants (organization_id, bot_id, tool_key, created_by_user_id, created_by_kind)
    values (${ORG_A}, ${BOT_A1}, 'write_file', ${USER}, 'member')`);
  assert(duplicate === "23505", `a second active grant was accepted: ${duplicate}`);
  const racer = await connect("ohb_api");
  const raced = await Promise.all([api, racer].map((sql) => asTenant(sql, ORG_A, (tx) =>
    createBotPermissionGrantTx(tx, { organizationId: ORG_A, botId: BOT_A2, toolKey: "patch", actor: MEMBER, approvalId: null }))));
  const patchRows = await owner`select id from bot_permission_grants where bot_id = ${BOT_A2} and tool_key = 'patch'`;
  assert(patchRows.length === 1 && raced[0]!.id === raced[1]!.id, `a double click made ${patchRows.length} grants`);

  // 3. Transitions: active -> revoked once; never back, never another tool; a new grant is a new row.
  const beforeRevoke = await revision(BOT_A1);
  const revoked = await asTenant(api, ORG_A, (tx) => revokeBotPermissionGrantTx(tx, { organizationId: ORG_A, botId: BOT_A1, grantId: first.id, actor: MEMBER, reason: null }));
  assert(revoked?.id === first.id && await revision(BOT_A1) === beforeRevoke + 1, "the revocation did not bump the revision");
  assert(await asTenant(api, ORG_A, (tx) => revokeBotPermissionGrantTx(tx, { organizationId: ORG_A, botId: BOT_A1, grantId: first.id, actor: MEMBER, reason: null })) === null,
    "a revoked grant was revoked twice");
  const reactivate = await refused(() => owner`update bot_permission_grants set status = 'active', revoked_at = null, revoked_by_user_id = null, revoked_by_kind = null where id = ${first.id}`);
  assert(reactivate === "23514", `a revoked grant was reactivated: ${reactivate}`);
  const retarget = await refused(() => owner`update bot_permission_grants set tool_key = 'skill_manage' where id = ${patchRows[0]!.id}`);
  assert(retarget === "23514", `a grant changed its tool: ${retarget}`);
  const renewed = await asTenant(api, ORG_A, (tx) => createBotPermissionGrantTx(tx, { organizationId: ORG_A, botId: BOT_A1, toolKey: "write_file", actor: MEMBER, approvalId: null }));
  assert(renewed.created && renewed.id !== first.id, "a grant after a revocation reused the revoked row");

  // 4. API RLS: another tenant sees nothing and cannot write into this one.
  const foreign = await asTenant(api, ORG_B, (tx) => tx`select id from bot_permission_grants`);
  assert(foreign.length === 0, "tenant B read tenant A's grants");
  const crossWrite = await refused(() => asTenant(api, ORG_B, (tx) => tx`insert into bot_permission_grants (organization_id, bot_id, tool_key, created_by_user_id, created_by_kind)
    values (${ORG_A}, ${BOT_A2}, 'skill_manage', ${USER}, 'member')`));
  assert(crossWrite !== "accepted", "tenant B wrote a grant into tenant A");
  assert((await asTenant(api, ORG_B, (tx) => activeGrantIdTx(tx, ORG_A, BOT_A1, "write_file"))) === null, "tenant B saw tenant A's grant");

  // 5. Worker: read-only, and only under its run's organization.
  const bare = await worker`select id from bot_permission_grants`;
  assert(bare.length === 0, "the worker read grants without an organization");
  assert((await asTenant(worker, ORG_A, (tx) => activeGrantIdTx(tx, ORG_A, BOT_A1, "write_file"))) === renewed.id, "the worker cannot read its organization's grant");
  assert((await asTenant(worker, ORG_B, (tx) => activeGrantIdTx(tx, ORG_A, BOT_A1, "write_file"))) === null, "the worker read across organizations");
  for (const write of [
    () => asTenant(worker, ORG_A, (tx) => tx`update bot_permission_grants set revoked_reason = 'x' where organization_id = ${ORG_A}`),
    () => asTenant(worker, ORG_A, (tx) => tx`insert into runtime_permission_settings (runtime_id, organization_id, terminal_danger_always, updated_by_user_id, updated_by_kind)
      values (${RUNTIME_A}, ${ORG_A}, true, ${USER}, 'member')`),
  ]) {
    const outcome = await refused(write);
    assert(outcome === "42501", `the worker could write a PERM2-4 table: ${outcome}`);
  }

  // 6. The runtime switch: every bot of the organization moves, nobody else; an unchanged value moves nothing.
  const [s1, s2, s3] = [await revision(BOT_A1), await revision(BOT_A2), await revision(BOT_B1)];
  const on = await asTenant(api, ORG_A, (tx) => setTerminalDangerAlwaysTx(tx, { organizationId: ORG_A, runtimeId: RUNTIME_A, value: true, actor: MEMBER }));
  assert(on?.changed, "the switch was not written");
  assert(await revision(BOT_A1) === s1 + 1 && await revision(BOT_A2) === s2 + 1 && await revision(BOT_B1) === s3, "the switch bumped the wrong bots");
  const same = await asTenant(api, ORG_A, (tx) => setTerminalDangerAlwaysTx(tx, { organizationId: ORG_A, runtimeId: RUNTIME_A, value: true, actor: MEMBER }));
  assert(same && !same.changed && await revision(BOT_A1) === s1 + 1, "an unchanged switch moved the revision");
  assert(await asTenant(api, ORG_B, (tx) => setTerminalDangerAlwaysTx(tx, { organizationId: ORG_B, runtimeId: RUNTIME_A, value: true, actor: MEMBER })) === null,
    "tenant B set tenant A's runtime");
  assert(await asTenant(worker, ORG_A, (tx) => readTerminalAlwaysTx(tx, ORG_A)), "the worker cannot read its runtime switch");
  assert(!(await asTenant(worker, ORG_B, (tx) => readTerminalAlwaysTx(tx, ORG_A))), "the worker read another organization's switch");
  assert((await worker`select runtime_id from runtime_permission_settings`).length === 0, "the worker read switches without an organization");

  // 7. The worker pipeline reads both, under the run's lock order, in its own transaction.
  const resolve = (gate: GateIdentity, bot = BOT_A1) => worker.begin((tx) => resolveGateTx(tx as unknown as SQL, { organizationId: ORG_A, botId: bot, neverWait: false }, gate, ["once", "deny"]));
  const granted = await resolve(WRITE_GATE);
  assert(granted.pipeline === "v2" && granted.choice === "once" && granted.decision.reason === "grant", `the grant did not answer: ${JSON.stringify(granted)}`);
  const ungranted = await resolve({ ...WRITE_GATE, toolKey: "skill_manage", gateArgs: { ...WRITE_ARGS, tool: "skill_manage", args: { action: "create", name: "notes" } } });
  assert(ungranted.pipeline === "v2" && ungranted.choice === null, "a tool without a grant was pre-approved");
  const terminal = await resolve(TERMINAL_GATE, BOT_A2);
  assert(terminal.pipeline === "v2" && terminal.choice === "once" && terminal.decision.reason === "terminal_switch", `the switch did not answer: ${JSON.stringify(terminal)}`);
  await owner`update runtimes set is_active = false where id = ${RUNTIME_A}`;
  const inactive = await resolve(TERMINAL_GATE, BOT_A2);
  assert(inactive.pipeline === "v2" && inactive.choice === null, "the switch of an inactive runtime still counted");
  await owner`update runtimes set is_active = true where id = ${RUNTIME_A}`;

  // 8. The answer route, end to end: "Always" is answered `once` and recorded; a failed record still answers `once`.
  const auth: AuthContext = { sessionId: "s", organizationId: ORG_A, userId: USER, role: "owner", kind: "web", credentialHash: "h" };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: (error as Error).message } }, 500));
  app.route("/", approvalRoutes(api));
  let gateNumber = 0;
  // `effectiveMode` is the bot's mode the worker decided the gate under:
  // only `auto` and `bypass` read a grant, so only they offer "Always".
  const pendingGate = async (gate: GateIdentity, effectiveMode = "auto") => {
    gateNumber += 1;
    const run = id(100 + gateNumber);
    const approval = id(200 + gateNumber);
    const thread = id(300 + gateNumber);
    // One active run per thread: each gate gets its own.
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${thread}, ${ORG_A}, ${BOT_A2}, 'Gate', ${`perm2-gate-${gateNumber}`}, false)`;
    await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status) values (${run}, ${ORG_A}, ${thread}, ${BOT_A2}, 'écris', 'awaiting_approval')`;
    await owner`insert into approval_requests (
        id, organization_id, thread_id, run_id, gate_ordinal, command, choices, expires_at, status,
        hermes_request_id, gate_kind, tool_key, gate_args, descriptor_version, decision_state, decision_detail
      ) values (
        ${approval}, ${ORG_A}, ${thread}, ${run}, 0, null, '["once","deny"]'::jsonb, now() + interval '10 minutes', 'pending',
        ${gate.hermesRequestId}, ${gate.gateKind}, ${gate.toolKey}, ${gate.gateArgs}, ${gate.descriptorVersion}, 'awaiting_human',
        ${{ reason: effectiveMode === "manual" ? "manual_mode" : "review_runtime_busy", effectiveMode }}
      )`;
    return approval;
  };
  const answer = async (approval: string, choice: string) => {
    const response = await app.request(`/${approval}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choice }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const gateRow = async (approval: string) => (await owner<Array<{ choice: string; state: string; detail: Record<string, unknown> }>>`
    select selected_choice as choice, decision_state as state, decision_detail as detail from approval_requests where id = ${approval}`)[0]!;

  const okGate = await pendingGate(WRITE_GATE);
  const before = await revision(BOT_A2);
  const ok = await answer(okGate, "always_bot_tool");
  assert(ok.status === 202 && (ok.body.always as { saved: boolean }).saved, `the Always answer failed: ${JSON.stringify(ok)}`);
  const okRow = await gateRow(okGate);
  const grantId = okRow.detail?.grantId as string;
  assert(okRow.choice === "once" && okRow.state === "decided" && typeof grantId === "string", `the gate was not answered once with its grant: ${JSON.stringify(okRow)}`);
  const stored = (await owner<Array<{ approval: string; tool: string }>>`select created_from_approval_id as approval, tool_key as tool from bot_permission_grants where id = ${grantId}`)[0];
  assert(stored?.approval === okGate && stored.tool === "write_file", "the grant does not point at its gate");
  assert(await revision(BOT_A2) === before + 1, "the card's grant did not bump the revision");
  const journal = (await owner<Array<{ choice: string; envelope: Record<string, unknown> }>>`select choice, envelope from decisions where approval_request_id = ${okGate}`)[0];
  assert(journal?.choice === "once" && journal.envelope.grantId === grantId, `the journal does not reference the grant: ${JSON.stringify(journal)}`);

  // A record that fails (a constraint the owner adds for this proof) still answers once.
  await owner.unsafe(`alter table bot_permission_grants add constraint perm2_4_proof_refuse check (tool_key <> 'send_message')`);
  const sendGate = await pendingGate({ ...WRITE_GATE, toolKey: "send_message", gateArgs: { ...WRITE_ARGS, tool: "send_message", args: { action: "send", platform: "email", target: "camille@example.com" } } });
  const failed = await answer(sendGate, "always_bot_tool");
  assert(failed.status === 202 && (failed.body.always as { saved: boolean; error: string }).saved === false, `a failed grant did not fall back: ${JSON.stringify(failed)}`);
  const failedRow = await gateRow(sendGate);
  assert(failedRow.choice === "once" && failedRow.detail?.grantError === "PERMISSION_GRANT_FAILED", `the fallback is not recorded: ${JSON.stringify(failedRow)}`);
  assert((await owner`select id from bot_permission_grants where tool_key = 'send_message'`).length === 0, "a refused grant was stored");
  assert((await owner`select id from decisions where approval_request_id = ${sendGate}`).length === 1, "the fallback once is missing from the journal");
  await owner.unsafe(`alter table bot_permission_grants drop constraint perm2_4_proof_refuse`);

  // An Always no longer offered (a deletion) decides nothing.
  const deleteGate = await pendingGate({ ...WRITE_GATE, gateArgs: { ...WRITE_ARGS, deletes: "yes" } });
  const unavailable = await answer(deleteGate, "always_bot_tool");
  assert(unavailable.status === 409 && (await gateRow(deleteGate)).state === "awaiting_human", `an unavailable Always decided the gate: ${JSON.stringify(unavailable)}`);

  // A manual gate never reads a grant: its "Always" is refused, nothing decided.
  const manualGate = await pendingGate(WRITE_GATE, "manual");
  const manual = await answer(manualGate, "always_bot_tool");
  assert(manual.status === 409 && (await gateRow(manualGate)).state === "awaiting_human", `a manual gate took an Always: ${JSON.stringify(manual)}`);

  console.log("PERM2-4 PostgreSQL proof passed: grants and runtime switch, RLS, unique index, transitions, revisions, worker read-only, answer route fallback.");
});
