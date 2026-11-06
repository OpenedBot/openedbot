/**
 * S2a (ADR 0001, section 5): a run in `unknown` outside the review trigger of
 * `0091_run_admission_envelope.sql` (no initiator, not a root, or inserted
 * directly in `unknown`). Either a review path exists, or the case is proven
 * impossible. Inventory: docs/architecture/0002-invariants-des-runs.md.
 *
 * What this proves, against a disposable PostgreSQL, the real producers, the
 * real claim and the real lease reaper (`sweepExpiredRuns`):
 *
 *  1. Inserted directly in `unknown`: impossible in production. Every
 *     `insert into runs` of the production code writes a literal `queued` or
 *     `relaying`. The database does not hold it (the trigger is
 *     `before update of status`): a direct insert in `unknown` gets no workflow.
 *  2. Root DM of a member: keeps its initiator. A root DM producer always
 *     sets `initiator_user_id`, and the account erasure keeps (pseudonymizes)
 *     a user that still has a membership row, so the FK does not null it; the
 *     trigger opens the review workflow. (An agency operator acting without a
 *     membership can be deleted, which nulls the initiator: D1, not tested.)
 *  3. Not a root: POSSIBLE, WITHOUT A REVIEW PATH (defect D1 of the
 *     inventory). A persona draft (`persona_draft`, current path) and an
 *     inbound handoff run (`step_kind` null; its producer is only reached from
 *     legacy DM runs, so it is called directly here) that lose their lease
 *     during the Hermes create become `unknown` with no workflow. Every exit
 *     from `unknown` is keyed by workflow (reconcile, abandon, retry), the
 *     thread and run stop routes refuse an `unknown` run, the thread stays
 *     blocked, a new persona draft is refused, and each orphan holds one slot
 *     of the runtime capacity.
 *
 * Section 3 characterizes today's behaviour. When S2b gives these runs a
 * review path, it fails on purpose: rewrite it to prove the new path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/index.ts";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import { runRoutes } from "../../apps/api/src/routes/conversation/run-routes";
import { HttpError } from "../../apps/api/src/interfaces/http/http-error";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { claimRun, sweepExpiredRuns } from "../../modules/execution/src/application/queue";
import { createHandoffTx } from "../../modules/execution/src/application/runner/handoff";
import type { RunContext } from "../../modules/execution/src/application/runner/types";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import { insertBotGreetingRun } from "../../modules/execution/src/sql/runs";
import { queuePersonaDraft } from "../../modules/roster/src/application/persona-drafts";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const USER = id(2);
const RUNTIME = id(3);
const SECTION = id(4);
const bots = { neo: id(101), trinity: id(102), morpheus: id(103), tank: id(104) };
const threads = { neo: id(201), trinity: id(202), morpheus: id(203), tank: id(204), direct: id(205) };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// --- 1. Static half: no production writer inserts a run in `unknown` ---------

const ROOT = resolve(import.meta.dir, "../..");
// Every production source file, so that a new writer anywhere is counted.
const PRODUCTION_SOURCES = [...new Bun.Glob("{apps,modules,platform}/**/src/**/*.{ts,tsx}").scanSync(ROOT)]
  .filter((file) => !/(^|\/)(node_modules|tests?|dist)\//u.test(file) && !/\.test\.tsx?$/u.test(file))
  .sort();
assert(PRODUCTION_SOURCES.length > 100, `production sources not found under ${ROOT}`);
const statuses: string[] = [];
for (const file of PRODUCTION_SOURCES) {
  const text = readFileSync(resolve(ROOT, file), "utf8");
  for (const match of text.matchAll(/insert\s+into\s+(?:public\.)?runs\s*\(/giu)) {
    const statement = text.slice(match.index, text.indexOf("`", match.index));
    const literal = /'(queued|relaying|starting|running|awaiting_approval|unknown|completed|failed|cancelled)'/u.exec(statement);
    assert(literal, `${file}: an insert into runs without a literal status`);
    statuses.push(`${file}:${literal[1]}`);
  }
}
// The inventory counts 16 production inserts; a new one must be reviewed there.
assert(statuses.length === 16, `expected 16 production inserts into runs, found ${statuses.length}`);
assert(statuses.every((entry) => entry.endsWith(":queued") || entry.endsWith(":relaying")),
  `a production insert does not start a run as queued or relaying: ${statuses.join(", ")}`);

// --- 2 and 3. Database half --------------------------------------------------

await withDisposablePostgres("openedbot2_s2a_unknown", async ({ owner, connect }) => {
  const api = await connect("openedbot_api");
  const worker = await connect("openedbot_worker");
  const key = secretEncryptionKey(new Uint8Array(32).fill(7));
  const bearer = encryptSecret("s2a-unused", key.value);
  await owner`insert into users (id, email) values (${USER}, 's2a-unknown@example.test')`;
  await owner`insert into organizations (id, slug, name) values (${ORG}, 's2a-unknown', 's2a-unknown')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'S2a', 0)`;
  // Never called: the worker crashes during the create, before any request.
  await owner`insert into runtimes (
      id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
      is_active, capacity, last_health_status, last_probed_at
    ) values (
      ${RUNTIME}, ${ORG}, 'Hermes', 'direct', 'http://127.0.0.1:9', ${bearer.ciphertext}, ${bearer.nonce},
      ${bearer.tag}, ${key.id}, true, 2, 'healthy', now() + interval '1 hour'
    )`;
  let position = 0;
  for (const [name, botId] of Object.entries(bots)) {
    await owner`insert into bots (id, organization_id, section_id, name, slug, position)
      values (${botId}, ${ORG}, ${SECTION}, ${name}, ${name}, ${position++})`;
    await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${threads[name as keyof typeof threads]}, ${ORG}, ${botId}, 'DM', ${`s2a-${name}`}, true)`;
  }
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${threads.direct}, ${ORG}, ${bots.tank}, 'Direct', 's2a-direct', false)`;

  const config: WorkerConfig = {
    workerId: "s2a-worker",
    apiInternalUrl: "http://127.0.0.1:9",
    apiInternalToken: "s2a",
    tokenEncryption: { current: key, previous: [] },
    hermesMtls: null,
    hermesEndpointPolicy: { environment: "test", testHttpUrl: "http://127.0.0.1:9" } as WorkerConfig["hermesEndpointPolicy"],
    leaseSeconds: 30,
    runInactivityMs: 20_000,
    runTimeoutMs: 30_000,
    reconciliationTimeoutMs: 10_000,
    billingEnforced: false,
    cachedInputTokenWeight: 0.1,
    webAppUrl: "http://127.0.0.1:1420",
  };

  const auth: AuthContext = {
    sessionId: "s2a-session", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "s2a",
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 409)
    : context.json({ code: "INTERNAL", message: String(error) }, 500));
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.route("/threads", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));
  app.route("/runs", runRoutes(api));
  const post = async (path: string) => {
    const response = await app.request(path, { method: "POST" });
    const body = response.status === 204 ? null : await response.json() as { code?: string };
    return { status: response.status, code: body?.code ?? null };
  };

  type RunRow = {
    status: string; workflowId: string | null; stepKind: string | null; initiator: string | null;
    externalState: string; errorCode: string | null; reviewWorkflows: number;
  };
  const runRow = async (runId: string) => (await owner<RunRow[]>`
    select status, workflow_id as "workflowId", step_kind as "stepKind", initiator_user_id as "initiator",
           external_state as "externalState", error_code as "errorCode",
           (select count(*)::int from workflows w where w.root_run_id = runs.id) as "reviewWorkflows"
      from runs where id = ${runId}`)[0]!;

  // The worker claims the run, posts `external_state = 'creating'` before the
  // Hermes create (provider-recovery.ts), then dies: its lease expires with no
  // Hermes id. The real reaper turns it `unknown` (HERMES_CREATE_OUTCOME_UNKNOWN).
  const loseLeaseDuringCreate = async (runId: string) => {
    const claimed = await claimRun(worker, config);
    assert(claimed?.id === runId, `expected to claim ${runId}, claimed ${claimed?.id ?? "nothing"}`);
    await worker`update runs set external_state = 'creating', events_complete = false,
        lease_expires_at = now() - interval '1 second', updated_at = now()
       where id = ${runId} and lease_owner = ${config.workerId} and status = 'starting'`;
    await sweepExpiredRuns(worker, config);
    return runRow(runId);
  };

  const proof: Array<Record<string, unknown>> = [];

  // 1b. The database does not refuse a direct insert in `unknown`, and the
  // review trigger (before update of status) does not see it.
  const direct = id(301);
  await owner`insert into runs (id, organization_id, thread_id, bot_id, input, status, step_index, step_kind,
      initiator_user_id, external_state)
    values (${direct}, ${ORG}, ${threads.direct}, ${bots.tank}, 'direct', 'unknown', 0, 'root', ${USER}, 'ambiguous')`;
  const directRow = await runRow(direct);
  assert(directRow.status === "unknown" && directRow.workflowId === null && directRow.reviewWorkflows === 0,
    `a direct insert in unknown unexpectedly got a workflow: ${JSON.stringify(directRow)}`);
  proof.push({ case: "insert direct en unknown (SQL brut)", ...directRow, production: "impossible (statique)" });
  await owner`delete from runs where id = ${direct}`;

  // 2. Root DM: the real producer sets the initiator, the account erasure
  // cannot null it while a membership row exists, and the trigger opens the
  // review workflow.
  const greeting = await worker.begin((tx) => insertBotGreetingRun(tx, {
    organizationId: ORG, threadId: threads.morpheus, botId: bots.morpheus, initiatorUserId: USER, input: "hello",
  }));
  await owner`update memberships set revoked_at = now() where organization_id = ${ORG} and user_id = ${USER}`;
  const erased = (await owner<Array<{ outcome: string }>>`select erase_account_user(${USER}) as outcome`)[0]!.outcome;
  assert(erased === "pseudonymized", `a user with a membership row was ${erased}, not pseudonymized`);
  await owner`update memberships set revoked_at = null where organization_id = ${ORG} and user_id = ${USER}`;
  const greetingRow = await loseLeaseDuringCreate(greeting);
  assert(greetingRow.initiator === USER, `the root DM lost its initiator: ${JSON.stringify(greetingRow)}`);
  assert(greetingRow.status === "unknown" && greetingRow.workflowId !== null && greetingRow.reviewWorkflows === 1,
    `the root DM in unknown got no review workflow: ${JSON.stringify(greetingRow)}`);
  proof.push({ case: "DM racine (accueil), initiateur gardé", ...greetingRow, review: "workflow 0091" });
  // Settle it the way the review does (abandon), so it holds no capacity.
  await owner`update runs set status = 'failed', updated_at = now() where id = ${greeting}`;

  // 3a. Inbound handoff: created by the real courier transaction, called
  // directly because only a legacy DM run (no `step_kind`) reaches it.
  const handoffContext = {
    id: id(302), organizationId: ORG, threadId: threads.neo, botId: bots.neo, botName: "neo", botSlug: "neo",
  } as unknown as RunContext;
  await worker.begin((tx) => createHandoffTx(tx, handoffContext, {
    botId: bots.trinity, slug: "trinity", name: "trinity", threadId: threads.trinity, message: "please check",
  }));
  const pair = (await owner<Array<{ inbound: string; courier: string }>>`
    select inbound.id as inbound, courier.id as courier from runs inbound
      join runs courier on courier.id = inbound.origin_run_id
     where inbound.thread_id = ${threads.trinity}`)[0]!;
  const inboundRow = await loseLeaseDuringCreate(pair.inbound);
  assert(inboundRow.status === "unknown" && inboundRow.errorCode === "HERMES_CREATE_OUTCOME_UNKNOWN",
    `the inbound handoff did not become unknown: ${JSON.stringify(inboundRow)}`);
  assert(inboundRow.stepKind === null && inboundRow.initiator === null, "the inbound handoff shape changed");
  assert(inboundRow.workflowId === null && inboundRow.reviewWorkflows === 0,
    `D1 fixed? the inbound handoff now has a review workflow: ${JSON.stringify(inboundRow)}`);
  const stopTarget = await post(`/threads/${threads.trinity}/stop`);
  const cancelInbound = await post(`/runs/${pair.inbound}/cancel`);
  assert(stopTarget.status === 409 && stopTarget.code === "WORKFLOW_REVIEW_REQUIRED",
    `the target thread stop answered ${JSON.stringify(stopTarget)}`);
  assert(cancelInbound.status === 409 && cancelInbound.code === "WORKFLOW_REVIEW_REQUIRED",
    `the inbound run cancel answered ${JSON.stringify(cancelInbound)}`);
  // The origin thread is held by the courier, which the operator can still stop.
  const courierBefore = (await runRow(pair.courier)).status;
  const stopOrigin = await post(`/threads/${threads.neo}/stop`);
  const courierAfter = (await runRow(pair.courier)).status;
  assert(courierBefore === "relaying" && stopOrigin.status === 204 && courierAfter === "cancelled",
    `the courier was not freed by the origin stop: ${courierBefore} -> ${JSON.stringify(stopOrigin)} -> ${courierAfter}`);
  assert((await runRow(pair.inbound)).status === "unknown", "stopping the origin thread settled the inbound run");
  proof.push({ case: "handoff entrant (step_kind null)", ...inboundRow,
    review: `aucune ; stop fil ${stopTarget.status}, cancel run ${cancelInbound.status}` });

  // 3b. Persona draft: queued by the real roster command.
  const draft = await queuePersonaDraft(api, ORG, bots.neo);
  assert(draft.runId, "the persona draft was not queued");
  const draftRow = await loseLeaseDuringCreate(draft.runId);
  assert(draftRow.status === "unknown" && draftRow.stepKind === "persona_draft",
    `the persona draft did not become unknown: ${JSON.stringify(draftRow)}`);
  assert(draftRow.workflowId === null && draftRow.reviewWorkflows === 0,
    `D1 fixed? the persona draft now has a review workflow: ${JSON.stringify(draftRow)}`);
  let refused: string | null = null;
  try { await queuePersonaDraft(api, ORG, bots.neo); } catch (error) {
    refused = error instanceof HttpError ? error.code : String(error);
  }
  assert(refused === "BOT_BUSY", `a new persona draft was not refused by the orphan: ${refused}`);
  proof.push({ case: "brouillon de persona", ...draftRow, review: "aucune ; nouveau brouillon BOT_BUSY" });

  // 3c. The orphans block their thread and hold the runtime capacity (2):
  // a turn in an unrelated thread is not claimable until the capacity grows.
  const blocked = await worker.begin((tx) => insertBotGreetingRun(tx, {
    organizationId: ORG, threadId: threads.trinity, botId: bots.trinity, initiatorUserId: USER, input: "next",
  }));
  const unrelated = await worker.begin((tx) => insertBotGreetingRun(tx, {
    organizationId: ORG, threadId: threads.tank, botId: bots.tank, initiatorUserId: USER, input: "other",
  }));
  assert(await claimRun(worker, config) === null, "a run was claimed while two orphans hold the capacity of 2");
  await owner`update runtimes set capacity = 3 where id = ${RUNTIME}`;
  const freed = await claimRun(worker, config);
  assert(freed?.id === unrelated, `with one more slot the unrelated turn should run, got ${freed?.id ?? "nothing"}`);
  // Settled, it frees its slot: only the thread rule can now hold `blocked`.
  await owner`update runs set status = 'completed', external_state = 'settled', lease_owner = null,
      lease_expires_at = null, ended_at = now(), updated_at = now() where id = ${unrelated}`;
  assert(await claimRun(worker, config) === null && (await runRow(blocked)).status === "queued",
    "the turn queued behind the orphan in its thread was claimed");
  proof.push({ case: "effets", status: "-", review: "fil cible bloqué ; 1 orphelin = 1 place de capacité" });

  console.table(proof);
  console.log("S2a proof passed: no production insert writes unknown; a root DM keeps its initiator and gets the 0091 review workflow;"
    + " DEFECT D1 characterized: a persona draft or a (legacy) inbound handoff that loses its lease during the Hermes create"
    + " stays unknown with no workflow, no review route, its thread blocked and one capacity slot held.");
});
