/**
 * Mode YOLO (PR 7/8), le mode solo local, against a disposable PostgreSQL
 * database (0167): only the owner of a one-member organization turns the
 * YOLO default on; the system then signs one 24 h runtime lease per runtime
 * for that owner (`.ssh`, `.env` and the keychain protected), renews it
 * before it runs out and never twice; a second member ends it (`superseded`,
 * consent reset, owner e-mailed) while the other leases stay; the cloud kill,
 * a host kill (`killedAt`, even for a lease renewed after it) and a manual
 * revocation of the solo lease all reset the consent, and a renewal never
 * comes back after any of them; the worker's due probe reads the real schema
 * under its tenant and asks the API, which alone signs.
 */
import type { SQL } from "bun";
import { HttpError } from "../../contracts/errors/src/http-error";
import { readOrganizationPermissionPolicy } from "../../modules/identity/src/sql/permission-policy";
import {
  buildYoloSoloLease,
  createYoloLeaseSigner,
  grantYoloLease,
  killYoloLeases,
  readYoloConsent,
  readYoloGrantInput,
  reconcileYoloSoloDefault,
  revokeYoloLease,
  saveYoloConsent,
  type YoloActor,
  type YoloLeaseDeps,
  type YoloLeasePublisher,
} from "../../modules/execution/src/application/yolo-leases";
import { signYoloLease, yoloSigningKeyFromSeed } from "../../modules/execution/src/domain/yolo-lease";
import { resetYoloLeaseSync, syncYoloLeases } from "../../apps/worker/src/maintenance/yolo-lease-sync";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const OTHER = id(2);
const OWNER = id(11);
const SECOND = id(12);
const OUTSIDER = id(13);
const SECTION = id(21);
const BOT = id(31);
const RUNTIME = id(51);
const RUNTIME_OLD = id(52);
const OTHER_RUNTIME = id(53);
const TOKEN_HASH = "a".repeat(64);
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

const actor = (userId: string, role: YoloActor["role"] = "owner", organizationId = ORG): YoloActor => ({ organizationId, userId, role, kind: "web" });

await withDisposablePostgres("ohb160_yolo_solo_local", async ({ owner, connect }) => {
  const api = await connect("ohb_api");
  const worker = await connect("ohb_worker");
  const pushed: Array<{ kind: "lease" | "revoke"; runtimeId: string; leaseId: string | null }> = [];
  const publisher: YoloLeasePublisher = {
    pushLease: async ({ runtimeId, frame }) => { pushed.push({ kind: "lease", runtimeId, leaseId: frame.lease.leaseId }); },
    pushRevoke: async ({ runtimeId, frame }) => { pushed.push({ kind: "revoke", runtimeId, leaseId: "leaseId" in frame ? frame.leaseId ?? null : null }); },
  };
  const deps: YoloLeaseDeps = {
    signer: createYoloLeaseSigner({ seed: TEST_SEED, previousSeeds: [] }),
    publisher,
    readPolicy: (tx, organizationId) => readOrganizationPermissionPolicy(tx, organizationId),
    webAppUrl: "https://app.example.test",
  };
  const turnOn = (who = actor(OWNER)) => saveYoloConsent(api, deps, who, { acknowledged: true, soloDefault: true });
  const reconcile = () => reconcileYoloSoloDefault(api, deps, ORG);
  const soloLeases = () => owner<Array<{ id: string; runtimeId: string; grantedBy: string; seconds: number; protect: string[]; revokedBy: string | null }>>`
    select id, runtime_id as "runtimeId", granted_by_user_id as "grantedBy", extract(epoch from expires_at - issued_at)::int as seconds,
           array(select jsonb_array_elements_text(payload -> 'protect')) as protect, revoked_by_user_id as "revokedBy"
      from permission_yolo_leases where organization_id = ${ORG} and solo_default and revoked_at is null`;
  const soloDefault = async () => (await owner<Array<{ on: boolean }>>`
    select coalesce(bool_or(solo_default), false) as on from permission_yolo_consents where organization_id = ${ORG}`)[0]!.on;

  for (const [user, email] of [[OWNER, "owner@example.com"], [SECOND, "second@example.com"], [OUTSIDER, "outsider@example.com"]] as const) {
    await owner`insert into users (id, email) values (${user}, ${email})`;
  }
  for (const [org, slug] of [[ORG, "solo"], [OTHER, "solo-other"]] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Atelier', 'v2')`;
  }
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${OWNER}, 'owner'), (${OTHER}, ${OUTSIDER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Atelier', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode, hermes_profile) values
    (${BOT}, ${ORG}, ${SECTION}, 'Designer', 'designer', 0, 'manual', 'designer')`;
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, link_token_hash, link_features) values
    (${RUNTIME}, ${ORG}, 'Mac', 'connector', true, ${TOKEN_HASH}, '{yolo_lease,yolo_thread_scope}'),
    (${RUNTIME_OLD}, ${ORG}, 'Old VPS', 'connector', false, ${"b".repeat(64)}, '{}'),
    (${OTHER_RUNTIME}, ${OTHER}, 'Other', 'connector', true, ${"c".repeat(64)}, '{yolo_lease}')`;

  // 1. Without consent nothing is signed; the owner of a one-member organization is eligible, nobody else.
  assert((await reconcile()).renewed === 0 && (await soloLeases()).length === 0, "a solo lease without consent");
  assert((await readYoloConsent(api, actor(OWNER))).soloEligible, "the sole owner is not eligible");
  assert(await refused(() => turnOn(actor(OWNER, "admin"))) === "403 ROLE_REQUIRED", "an admin turned the solo default on");
  assert(await refused(() => turnOn(actor(OUTSIDER))) === "409 YOLO_SOLO_NOT_ELIGIBLE members", "a non-member of the organization turned it on");

  // 2. Turned on: one 24 h runtime lease at once, for the owner, on the runtime that applies leases only, protections in.
  const on = await turnOn();
  assert(on.soloDefault && on.soloEligible, `the consent did not hold: ${JSON.stringify(on)}`);
  const [first, ...others] = await soloLeases();
  assert(first && others.length === 0, "not exactly one solo lease");
  assert(first.runtimeId === RUNTIME && first.grantedBy === OWNER && first.seconds === 86_400, `unexpected solo lease: ${JSON.stringify(first)}`);
  assert(["ssh", "env", "keychain"].every((protection) => first.protect.includes(protection)), `a solo lease without its protections: ${first.protect}`);
  assert(pushed.some((entry) => entry.kind === "lease" && entry.leaseId === first.id), "the first solo lease was not pushed");

  // 3. Idempotent: replayed passes sign nothing more, one live solo lease per runtime.
  assert((await reconcile()).renewed === 0 && (await reconcile()).renewed === 0, "a lease far from its end was renewed");
  assert((await soloLeases()).map((row) => row.id).join() === first.id, "two live solo leases on one runtime");

  // 4. Before it runs out, a renewal supersedes it (here: a margin wider than the lease, as if 18 h had gone by).
  const key = yoloSigningKeyFromSeed(TEST_SEED);
  const solo = async (who: string, renewBefore: number, mutate: (lease: Record<string, unknown>) => void = () => {}) => {
    const lease = buildYoloSoloLease({ organizationId: ORG, runtimeId: RUNTIME, ownerUserId: OWNER, commandBlocklist: [], now: Math.floor(Date.now() / 1000) });
    const payload = { ...lease } as Record<string, unknown>;
    mutate(payload);
    const signed = signYoloLease(lease, key);
    return asTenant(api, ORG, (tx) => tx<Array<{ status: string }>>`
      select status from grant_permission_yolo_solo_lease(${ORG}::uuid, ${who}::uuid, ${signed.keyId}, ${signed.signature},
        ${JSON.stringify(payload)}::text::jsonb, ${renewBefore}::integer)`);
  };
  assert((await solo(OWNER, 90_000))[0]?.status === "granted", "a due renewal was refused");
  const renewed = await soloLeases();
  const replaced = (await owner<Array<{ reason: string; by: string | null }>>`
    select revoke_reason as reason, revoked_by_user_id as by from permission_yolo_leases where id = ${first.id}`)[0];
  assert(renewed.length === 1 && renewed[0]!.id !== first.id && replaced?.reason === "superseded" && replaced.by === null,
    `the renewal did not supersede: ${JSON.stringify({ renewed, replaced })}`);
  // The database refuses a solo lease that is not exactly that: unprotected, another grantor, another scope, another tenant, the worker.
  assert(await refused(() => solo(OWNER, 0, (p) => { p.protect = ["git_config"]; })) === "22023", "an unprotected solo lease was stored");
  assert(await refused(() => solo(OWNER, 0, (p) => { p.grantedBy = SECOND; })) === "22023", "a solo lease named another grantor");
  assert(await refused(() => solo(OWNER, 0, (p) => { p.scope = "bot"; p.profile = "designer"; })) === "22023", "a solo lease of bot scope");
  assert(await refused(() => asTenant(api, OTHER, (tx) => tx`select * from grant_permission_yolo_solo_lease(${ORG}::uuid, ${OWNER}::uuid, 'k', 's', '{}'::jsonb, 0)`)) === "42501",
    "a tenant granted another's solo lease");
  assert(await refused(() => asTenant(worker, ORG, (tx) => tx`select * from end_permission_yolo_solo_default(${ORG}::uuid, null)`)) === "42501",
    "the worker ended the solo default itself");
  assert((await asTenant(api, ORG, (tx) => tx<Array<{ status: string }>>`select status from end_permission_yolo_solo_default(${ORG}::uuid, null)`))[0]?.status === "still_solo",
    "the system ended the solo default of a solo organization");

  // 5. The worker's probe, on the real schema under its tenant: nothing due now; a lease it would renew asks the API.
  const calls: string[] = [];
  const workerPass = async () => {
    resetYoloLeaseSync();
    return syncYoloLeases(worker, {
      apiInternalUrl: "http://api.test", apiInternalToken: "internal-token",
      fetchImpl: async (url) => { calls.push(String(url)); return Response.json({ pushed: false }); },
    } as Parameters<typeof syncYoloLeases>[1]);
  };
  assert((await workerPass()).solo === 0 && calls.length === 0, `the worker asked for a renewal not due: ${calls}`);

  // 6. The cloud kill resets the consent: a pass afterwards renews nothing.
  await killYoloLeases(api, deps, actor(OWNER));
  assert(!(await soloDefault()) && (await soloLeases()).length === 0, "the kill left the solo default");
  assert((await reconcile()).renewed === 0 && (await soloLeases()).length === 0, "a renewal came back after the kill");
  assert((await workerPass()).solo === 0 && calls.length === 0, "the worker asked for a renewal after the kill");

  // 7. A host kill (`edge-setup yolo off`, ingested) resets it too, even for a solo lease issued after `killedAt`.
  await turnOn();
  const afterKill = (await soloLeases())[0];
  assert(afterKill, "turned on again, no solo lease");
  const killedAt = new Date(Date.now() - 3_600_000);
  await asTenant(api, ORG, (tx) => tx`select lease_id from revoke_permission_yolo_leases_by_host(
    ${ORG}::uuid, ${RUNTIME}::uuid, ${TOKEN_HASH}, null, ${killedAt}::timestamptz, 'host_cli')`);
  const hostKilled = (await owner<Array<{ reason: string }>>`select revoke_reason as reason from permission_yolo_leases where id = ${afterKill.id}`)[0];
  assert(hostKilled?.reason === "host_cli" && !(await soloDefault()), "a host kill left the solo default or its lease");
  assert((await reconcile()).renewed === 0 && (await soloLeases()).length === 0, "a renewal came back after the host kill");

  // 8. Revoking the solo lease by hand turns the default off: the next pass does not bring it back.
  await turnOn();
  await revokeYoloLease(api, deps, actor(OWNER), (await soloLeases())[0]!.id);
  assert(!(await soloDefault()) && (await reconcile()).renewed === 0 && (await soloLeases()).length === 0, "a revoked solo lease came back");

  // 9. A second member arrives: not eligible any more; the pass ends it (superseded), e-mails the owner, keeps the other leases.
  await turnOn();
  const manual = await grantYoloLease(api, deps, actor(OWNER), readYoloGrantInput({ scope: "bot", botId: BOT, acknowledged: true }));
  const soloBefore = (await soloLeases())[0]!;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${SECOND}, 'member')`;
  assert(await refused(() => turnOn()) === "409 YOLO_SOLO_NOT_ELIGIBLE members", "a crowded organization turned the solo default on");
  assert(!(await readYoloConsent(api, actor(OWNER))).soloEligible, "a crowded organization is still eligible");
  calls.length = 0;
  assert((await workerPass()).solo === 1 && calls.join() === `http://api.test/internal/yolo/solo-default/${ORG}/reconcile`,
    `the worker did not hand the second member to the API: ${calls}`);
  pushed.length = 0;
  const ended = await reconcile();
  assert(ended.ended && ended.renewed === 0, `the pass did not end the solo default: ${JSON.stringify(ended)}`);
  const superseded = (await owner<Array<{ reason: string; by: string | null }>>`
    select revoke_reason as reason, revoked_by_user_id as by from permission_yolo_leases where id = ${soloBefore.id}`)[0];
  assert(superseded?.reason === "superseded" && superseded.by === null && !(await soloDefault()), `not superseded: ${JSON.stringify(superseded)}`);
  assert(pushed.some((entry) => entry.kind === "revoke" && entry.leaseId === soloBefore.id), "the host was not told");
  assert((await owner`select 1 from permission_yolo_leases where id = ${manual.id} and revoked_at is null`).length === 1, "the manual lease was revoked too");
  const emails = await owner<Array<{ recipient: string; payload: Record<string, unknown> }>>`
    select recipient_email as recipient, payload from email_outbox where kind = 'yolo_solo_default_ended'`;
  assert(emails.length === 1 && emails[0]!.recipient === "owner@example.com" && emails[0]!.payload.reason === "members"
    && emails[0]!.payload.settingsUrl === "https://app.example.test/o/solo/settings/runtime", `unexpected e-mail: ${JSON.stringify(emails)}`);
  assert(!(await reconcile()).ended && (await owner`select 1 from email_outbox where kind = 'yolo_solo_default_ended'`).length === 1, "the end was replayed");
  assert((await soloLeases()).length === 0, "a solo lease survived the second member");

  // 10. Tenants: another organization never reads this one's solo leases nor its consent.
  assert((await asTenant(api, OTHER, (tx) => tx`select 1 from permission_yolo_leases where solo_default`)).length === 0, "a tenant read another's solo leases");
});

console.log("yolo-solo-local integration: consent, 24 h renewal, idempotence, second member, cloud and host kills hold on PostgreSQL.");
