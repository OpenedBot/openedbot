/**
 * Mode YOLO (PR 2/8) against a disposable PostgreSQL database (0165): only a
 * live owner or admin grants, through the definer function and inside its
 * own tenant; the API never inserts, deletes nor un-revokes a lease; the
 * columns are derived from the signed payload and a lease lasts 24 h at
 * most; one live lease per target (a new grant supersedes); the policy,
 * the host features and the first confirmation are explicit refusals; the
 * kill switch revokes everything and resets the solo default; tenants never
 * see each other's leases, consents or audit; the audit is append-only and
 * idempotent on (runtime_id, write_seq); the worker gate reads a live lease
 * under the run's tenant and forgets it once revoked; the approval stage
 * `yolo` is accepted.
 */
import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { HttpError } from "../../contracts/errors/src/http-error";
import { readOrganizationPermissionPolicy, writeOrganizationPermissionPolicy } from "../../modules/identity/src/sql/permission-policy";
import {
  createYoloLeaseSigner,
  grantYoloLease,
  killYoloLeases,
  NO_YOLO_PUBLISHER,
  readYoloGrantInput,
  revokeYoloLease,
  type YoloActor,
  type YoloLeaseDeps,
} from "../../modules/execution/src/application/yolo-leases";
import { resolveGateTx } from "../../modules/execution/src/application/runner/permission-gate";
import { readGateIdentity } from "../../modules/execution/src/domain/gate-identity";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `95800000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const OTHER = id(2);
const OWNER = id(11);
const ADMIN = id(12);
const MEMBER = id(13);
const OUTSIDER = id(14);
const SECTION = id(21);
const OTHER_SECTION = id(22);
const BOT = id(31);
const BOT_NO_PROFILE = id(32);
const OTHER_BOT = id(33);
const THREAD = id(41);
const RUNTIME = id(51);
const RUNTIME_OLD = id(52);
const RUNTIME_PARTIAL = id(53);
const OTHER_RUNTIME = id(54);
const SESSION = "hermes-session-yolo";
// A public TEST seed (0x00..0x1f), the one of the shared lease vector: never a real key.
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);

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
    if (error instanceof HttpError) return `${error.status} ${error.code}${error.details?.reason ? ` ${String(error.details.reason)}` : ""}`;
    const details = error as { errno?: unknown; code?: unknown; message?: unknown };
    return String(details.errno ?? details.code ?? details.message);
  }
  throw new Error("the operation was expected to fail");
}

const actor = (userId: string, role: YoloActor["role"] = "owner"): YoloActor => ({ organizationId: ORG, userId, role, kind: "web" });

await withDisposablePostgres("ohb158_yolo_leases", async ({ owner, connect }) => {
  const api = await connect("ohb_api");
  const worker = await connect("ohb_worker");
  const deps: YoloLeaseDeps = {
    signer: createYoloLeaseSigner({ seed: TEST_SEED, previousSeeds: [] }),
    publisher: NO_YOLO_PUBLISHER,
    readPolicy: (tx, organizationId) => readOrganizationPermissionPolicy(tx, organizationId),
  };
  const grant = (body: Record<string, unknown>, who = actor(OWNER)) => grantYoloLease(api, deps, who, readYoloGrantInput(body));

  for (const [user, email] of [[OWNER, "owner@example.com"], [ADMIN, "admin@example.com"], [MEMBER, "member@example.com"], [OUTSIDER, "outsider@example.com"]] as const) {
    await owner`insert into users (id, email) values (${user}, ${email})`;
  }
  for (const [org, slug] of [[ORG, "yolo"], [OTHER, "yolo-other"]] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Acme', 'v2')`;
  }
  await owner`insert into memberships (organization_id, user_id, role) values
    (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${ADMIN}, 'admin'), (${ORG}, ${MEMBER}, 'member'), (${OTHER}, ${OUTSIDER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Acme', 0), (${OTHER_SECTION}, ${OTHER}, 'Acme', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode, hermes_profile) values
    (${BOT}, ${ORG}, ${SECTION}, 'Designer', 'designer', 0, 'manual', 'designer'),
    (${BOT_NO_PROFILE}, ${ORG}, ${SECTION}, 'Root', 'root', 1, 'manual', null),
    (${OTHER_BOT}, ${OTHER}, ${OTHER_SECTION}, 'Pixel', 'pixel', 0, 'manual', 'pixel')`;
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id) values
    (${THREAD}, ${ORG}, ${BOT}, 'Task', ${SESSION})`;
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, link_token_hash, link_features) values
    (${RUNTIME}, ${ORG}, 'Mac', 'connector', true, ${"a".repeat(64)}, '{yolo_lease,yolo_thread_scope}'),
    (${RUNTIME_OLD}, ${ORG}, 'Old VPS', 'connector', false, ${"b".repeat(64)}, '{}'),
    (${RUNTIME_PARTIAL}, ${ORG}, 'Linux', 'connector', false, ${"c".repeat(64)}, '{yolo_lease}'),
    (${OTHER_RUNTIME}, ${OTHER}, 'Other', 'connector', true, ${"d".repeat(64)}, '{yolo_lease,yolo_thread_scope}')`;
  const revision = async (bot: string) => Number((await owner<Array<{ r: string }>>`select permission_revision as r from bots where id = ${bot}`)[0]!.r);
  const live = async () => owner<Array<{ id: string; scope: string }>>`select id, scope from permission_yolo_leases where revoked_at is null`;

  // 1. A member is refused by the application and by the database itself; nothing is written.
  assert(await refused(() => grant({ scope: "runtime", acknowledged: true }, actor(MEMBER, "member"))) === "403 ROLE_REQUIRED", "a member granted");
  assert(await refused(() => grant({ scope: "runtime", acknowledged: true }, actor(MEMBER, "owner"))) === "42501", "the definer trusted the caller's role");
  assert(await refused(() => grant({ scope: "runtime", acknowledged: true }, { ...actor(OUTSIDER), organizationId: ORG })) === "42501",
    "a user of another organization granted");
  assert((await live()).length === 0, "a refused grant left a lease");

  // 2. The first grant needs the confirmation; an unsupported host is named.
  assert(await refused(() => grant({ scope: "bot", botId: BOT })) === "428 YOLO_ACK_REQUIRED", "a first grant skipped the confirmation");
  assert(await refused(() => grant({ scope: "runtime", runtimeId: RUNTIME_OLD, acknowledged: true })) === "409 YOLO_HOST_UNSUPPORTED yolo_lease",
    "a host without yolo_lease got a lease");
  assert(await refused(() => grant({ scope: "thread", runtimeId: RUNTIME_PARTIAL, botId: BOT, threadId: THREAD, acknowledged: true }))
    === "409 YOLO_HOST_UNSUPPORTED yolo_thread_scope", "a thread lease was widened on a host without the thread scope");
  assert(await refused(() => grant({ scope: "bot", botId: BOT_NO_PROFILE, acknowledged: true })) === "409 YOLO_HOST_UNSUPPORTED bot_profile_missing",
    "a bot without a profile got a lease");
  assert(await refused(() => grant({ scope: "runtime", runtimeId: OTHER_RUNTIME, acknowledged: true })) === "404 YOLO_RUNTIME_NOT_FOUND",
    "a lease crossed tenants");
  assert(await refused(() => grant({ scope: "bot", botId: OTHER_BOT, acknowledged: true })) === "404 YOLO_TARGET_NOT_FOUND", "another tenant's bot was targeted");
  assert((await owner`select 1 from permission_yolo_consents`).length === 0, "a refused grant recorded the confirmation");

  // 3. A thread lease: columns derived from the signed payload, confirmation recorded, revision raised.
  const before = await revision(BOT);
  const first = await grant({ scope: "thread", botId: BOT, threadId: THREAD, acknowledged: true });
  const stored = (await owner<Array<{ sessionKey: string; profile: string; runtimeId: string; seconds: number; grantedBy: string }>>`
    select session_key as "sessionKey", profile, runtime_id as "runtimeId", extract(epoch from expires_at - issued_at)::int as seconds,
           granted_by_user_id as "grantedBy"
      from permission_yolo_leases where id = ${first.id}`)[0];
  assert(stored?.sessionKey === createHash("sha256").update(SESSION).digest("hex") && stored.profile === "designer" && stored.runtimeId === RUNTIME
    && stored.seconds === 14_400 && stored.grantedBy === OWNER, `unexpected stored lease: ${JSON.stringify(stored)}`);
  assert(await revision(BOT) === before + 1, "a grant did not raise the bot revision");
  assert((await owner`select 1 from permission_yolo_consents where organization_id = ${ORG} and user_id = ${OWNER}`).length === 1, "the confirmation was not recorded");

  // 4. A new grant on the same target supersedes the previous one; later grants need no confirmation.
  const second = await grant({ scope: "thread", botId: BOT, threadId: THREAD });
  const superseded = (await owner<Array<{ reason: string }>>`select revoke_reason as reason from permission_yolo_leases where id = ${first.id}`)[0];
  assert(superseded?.reason === "superseded" && (await live()).map((row) => row.id).join() === second.id, "two live leases on one target");

  // 5. The policy: a ceiling below bypass or an enforced review refuses; the blocklist is signed in.
  const policy = (overrides: Partial<Parameters<typeof writeOrganizationPermissionPolicy>[1]>) => asTenant(api, ORG, (tx) => writeOrganizationPermissionPolicy(tx, {
    organizationId: ORG, actorUserId: OWNER, maxMode: "bypass", enforceReview: false, rulesMode: "adds", commandBlocklist: [], expectedVersion: 0, ...overrides,
  }));
  assert((await policy({ maxMode: "auto" })).status === "saved", "policy save failed");
  assert(await refused(() => grant({ scope: "runtime" }, actor(ADMIN, "admin"))) === "409 YOLO_BLOCKED_BY_POLICY ceiling", "a ceiling did not refuse");
  assert((await policy({ maxMode: null, enforceReview: true, expectedVersion: 1 })).status === "saved", "policy save failed");
  assert(await refused(() => grant({ scope: "runtime" }, actor(ADMIN, "admin"))) === "409 YOLO_BLOCKED_BY_POLICY enforce_review", "an enforced review did not refuse");
  assert((await policy({ maxMode: "bypass", commandBlocklist: ["rm -rf"], expectedVersion: 2 })).status === "saved", "policy save failed");
  const runtimeLease = await grant({ scope: "runtime", acknowledged: true }, actor(ADMIN, "admin"));
  const deny = (await owner<Array<{ deny: unknown }>>`select payload -> 'deny' -> 'commands' as deny from permission_yolo_leases where id = ${runtimeLease.id}`)[0];
  assert(JSON.stringify(deny?.deny) === JSON.stringify(["rm -rf"]), `the blocklist was not signed in: ${JSON.stringify(deny)}`);

  // 6. Tenants: another organization and an unbound worker see nothing; the bound worker sees its own.
  assert((await asTenant(api, OTHER, (tx) => tx`select 1 from permission_yolo_leases`)).length === 0, "a tenant read another's leases");
  assert((await asTenant(api, OTHER, (tx) => tx`select 1 from permission_yolo_consents`)).length === 0, "a tenant read another's consents");
  assert((await worker`select 1 from permission_yolo_leases`).length === 0, "an unbound worker read every lease");
  assert((await asTenant(worker, ORG, (tx) => tx`select 1 from permission_yolo_leases`)).length === 3, "the bound worker cannot read its tenant's leases");

  // 7. No delete, no direct insert, no un-revoke, nothing signed rewritten; host state is writable.
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`delete from permission_yolo_leases`)) === "42501", "the API deleted a lease");
  assert(await refused(() => asTenant(worker, ORG, (tx) => tx`delete from permission_yolo_leases`)) === "42501", "the worker deleted a lease");
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`insert into permission_yolo_leases (id, organization_id, runtime_id, scope, granted_by_user_id,
    issued_at, not_before, expires_at, key_id, signature, payload) values (${id(90)}, ${ORG}, ${RUNTIME}, 'runtime', ${OWNER}, now(), now(), now() + interval '1 hour',
    ${"0".repeat(32)}, ${`${"A".repeat(86)}==`}, '{}'::jsonb)`)) === "42501", "the API inserted a lease directly");
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`update permission_yolo_leases set revoked_at = null where id = ${first.id}`)) === "42501",
    "the API wrote a revocation column");
  await asTenant(api, ORG, (tx) => tx`update permission_yolo_leases set host_state = 'active', host_state_at = now(), delivered_at = now() where id = ${second.id}`);
  assert(await refused(() => owner`update permission_yolo_leases set revoked_at = null, revoke_reason = null, revoked_by_user_id = null where id = ${first.id}`) === "42501",
    "a revoked lease came back to life");
  assert(await refused(() => owner`update permission_yolo_leases set expires_at = expires_at + interval '1 hour' where id = ${second.id}`) === "42501",
    "a signed window was rewritten");

  // 8. 24 h at most, a coherent scope, a user as grantor: even the table owner cannot store otherwise.
  const insertRaw = (scope: string, hours: number, grantor: string | null, bot: string | null = null) => owner`insert into permission_yolo_leases
    (id, organization_id, runtime_id, scope, bot_id, profile, granted_by_user_id, issued_at, not_before, expires_at, key_id, signature, payload)
    values (${crypto.randomUUID()}, ${ORG}, ${RUNTIME_OLD}, ${scope}, ${bot}, ${bot ? "designer" : null}, ${grantor}, now(), now(),
            now() + make_interval(hours => ${hours}), ${"0".repeat(32)}, ${`${"A".repeat(86)}==`}, '{}'::jsonb)`;
  assert(await refused(() => insertRaw("runtime", 25, OWNER)) === "23514", "a lease of more than 24 h was stored");
  assert(await refused(() => insertRaw("bot", 1, OWNER)) === "23514", "a bot lease without a bot was stored");
  assert(await refused(() => insertRaw("runtime", 1, null)) === "23502", "a lease without a human grantor was stored");
  assert(await refused(() => insertRaw("runtime", 1, BOT)) === "23503", "a bot id was accepted as a grantor");

  // 9. The worker gate reads the live lease under the run's tenant, and forgets it once revoked.
  const gate = readGateIdentity({ request_id: "req-yolo", pattern_key: "dangerous_command", command: "chmod 777 build" });
  const context = { organizationId: ORG, botId: BOT, neverWait: false, runtimeId: RUNTIME, threadId: THREAD };
  const leased = await worker.begin((tx) => resolveGateTx(tx as unknown as SQL, context, gate, ["once", "deny"]));
  assert(leased.pipeline === "v2" && leased.decision.stage === "yolo" && leased.choice === "once" && leased.detail.yoloLeaseId === second.id,
    `the gate ignored the live lease: ${JSON.stringify(leased)}`);
  const blocked = await worker.begin((tx) => resolveGateTx(tx as unknown as SQL, context,
    readGateIdentity({ request_id: "req-rm", pattern_key: "dangerous_command", command: "rm -rf build" }), ["once", "deny"]));
  // The organization blocklist refuses first (stage `forbidden`), lease or not.
  assert(blocked.pipeline === "v2" && blocked.choice === "deny", `the blocklist did not refuse under a lease: ${JSON.stringify(blocked)}`);

  // 10. Revocation: by a member refused; by an owner it holds and a replay changes nothing.
  assert(await refused(() => revokeYoloLease(api, deps, actor(MEMBER, "member"), second.id)) === "403 ROLE_REQUIRED", "a member revoked");
  const revoked = await revokeYoloLease(api, deps, actor(OWNER), second.id);
  const replay = await revokeYoloLease(api, deps, actor(OWNER), second.id);
  assert(revoked.revokedAt !== null && replay.revokedAt === revoked.revokedAt, "a revocation replay moved the lease");
  // The thread lease is gone; the wider runtime lease answers now.
  const after = await worker.begin((tx) => resolveGateTx(tx as unknown as SQL, context, gate, ["once", "deny"]));
  assert(after.pipeline === "v2" && after.detail.yoloLeaseId === runtimeLease.id, `a revoked lease still answered: ${JSON.stringify(after)}`);

  // 11. The kill switch revokes everything and resets the solo default.
  await asTenant(api, ORG, (tx) => tx`update permission_yolo_consents set solo_default = true where user_id = ${OWNER}`);
  const killed = await killYoloLeases(api, deps, actor(ADMIN, "admin"));
  assert(killed.revoked === 1 && (await live()).length === 0, `the kill switch left a lease: ${JSON.stringify(killed)}`);
  assert((await owner`select 1 from permission_yolo_consents where solo_default`).length === 0, "the kill switch kept the solo default");
  const reasons = (await owner<Array<{ reason: string }>>`select revoke_reason as reason from permission_yolo_leases where id = ${runtimeLease.id}`)[0];
  assert(reasons?.reason === "kill_switch", "the kill switch did not name itself");
  const unleashed = await worker.begin((tx) => resolveGateTx(tx as unknown as SQL, context, gate, ["once", "deny"]));
  assert(unleashed.pipeline === "v2" && unleashed.decision.stage !== "yolo" && unleashed.choice === null,
    `a gate was still auto-approved after the kill switch: ${JSON.stringify(unleashed)}`);

  // 12. The audit: append-only, idempotent on (runtime_id, write_seq), tenant-scoped.
  const audit = (seq: number) => asTenant(api, ORG, (tx) => tx`insert into permission_yolo_audit
    (organization_id, runtime_id, lease_id, write_seq, event_id, occurred_at, profile, gate_kind, tool_key, args_hash, prev_hash, entry_hash)
    values (${ORG}, ${RUNTIME}, ${second.id}, ${seq}, ${crypto.randomUUID()}, now(), 'designer', 'terminal_danger', null,
            ${"a".repeat(64)}, ${"0".repeat(64)}, ${"b".repeat(64)})`);
  await audit(1);
  assert(await refused(() => audit(1)) === "23505", "a replayed audit entry was stored twice");
  assert(await refused(() => owner`update permission_yolo_audit set profile = 'other'`) === "42501", "the audit was rewritten");
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`delete from permission_yolo_audit`)) === "42501", "the API deleted the audit");
  assert((await asTenant(api, OTHER, (tx) => tx`select 1 from permission_yolo_audit`)).length === 0, "a tenant read another's audit");

  // 13. The approval stage `yolo` is accepted by the decision constraint (0144 extended).
  const definition = (await owner<Array<{ def: string }>>`select pg_get_constraintdef(oid) as def from pg_constraint
    where conname = 'approval_requests_decision_stage_check'`)[0]?.def ?? "";
  assert(definition.includes("'yolo'") && definition.includes("'unattended'"), `the stage constraint does not know yolo: ${definition}`);
});

console.log("yolo-leases integration: grants, refusals, RLS, append-only audit, kill switch and gate read hold on PostgreSQL.");
