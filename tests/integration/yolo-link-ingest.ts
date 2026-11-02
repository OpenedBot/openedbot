/**
 * Mode YOLO (PR 4/8) against a disposable PostgreSQL database (0158, 0159):
 * what the link writes when the host talks about its leases, under the API
 * role and the organization tenant, and what the worker pushes again.
 *
 *   - `yolo.state`: delivery and host state written; a live lease the host
 *     does not name is handed back, an active lease the cloud no longer
 *     holds is taken back; `killedAt` revokes here every lease issued up to
 *     it (`host_cli`, no human actor), a host refusal revokes (`host_rejected`);
 *   - the host revocation needs the runtime's own link token: another
 *     runtime's token, a wrong one or another tenant are refused;
 *   - `yolo.audit`: the chain is verified, an insert is idempotent on
 *     (runtime, seq), a broken chain is quarantined (append-only, tenant
 *     scoped), journaled and mailed to owners and admins, never dropped;
 *   - the worker pass marks elapsed leases expired and pushes again what was
 *     not delivered and what the host still holds after a revocation.
 */
import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { readOrganizationPermissionPolicy } from "../../modules/identity/src/sql/permission-policy";
import {
  createYoloLeaseSigner,
  grantYoloLease,
  NO_YOLO_PUBLISHER,
  readYoloGrantInput,
  revokeYoloLease,
  type YoloActor,
  type YoloLeaseDeps,
} from "../../modules/execution/src/application/yolo-leases";
import { createLinkLivenessStore } from "../../modules/runtime-link/src/application/link-persistence";
import { yoloAuditEntryHash, yoloAuditGenesis } from "../../modules/runtime-link/src/application/link-yolo";
import type { LinkIdentity } from "../../modules/runtime-link/src/application/link-types";
import type { RelayYoloAuditEntry, RelayYoloAuditFrame } from "../../contracts/connector/src/relay-frames-yolo";
import { resetYoloLeaseSync, syncYoloLeases } from "../../apps/worker/src/maintenance/yolo-lease-sync";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `95900000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const OTHER = id(2);
const OWNER = id(11);
const ADMIN = id(12);
const OUTSIDER = id(14);
const SECTION = id(21);
const BOT = id(31);
const RUNTIME = id(51);
const SIBLING = id(52);
const OTHER_RUNTIME = id(54);
const TOKEN = "a".repeat(64);
const SIBLING_TOKEN = "b".repeat(64);
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
    const details = error as { errno?: unknown; code?: unknown; message?: unknown };
    return String(details.errno ?? details.code ?? details.message);
  }
  throw new Error("the operation was expected to fail");
}

function chain(count: number, leaseId: string, after: { seq: number; hash: string } | null): RelayYoloAuditEntry[] {
  const entries: RelayYoloAuditEntry[] = [];
  let seq = after?.seq ?? 0;
  let prev = after?.hash ?? yoloAuditGenesis(RUNTIME);
  for (let index = 0; index < count; index++) {
    seq += 1;
    const body = {
      seq, eventId: crypto.randomUUID(), occurredAt: Math.floor(Date.now() / 1000), leaseId, profile: "designer",
      gateKind: "plugin_tool", toolKey: "write_file", argsHash: createHash("sha256").update(`{"path":"/tmp/${seq}"}`).digest("hex"), prevHash: prev,
    };
    const entryHash = yoloAuditEntryHash(body);
    entries.push({ ...body, entryHash });
    prev = entryHash;
  }
  return entries;
}

const frameOf = (entries: RelayYoloAuditEntry[]): RelayYoloAuditFrame => ({
  t: "yolo.audit", runtimeId: RUNTIME, entries, fromSeq: entries[0]!.seq, toSeq: entries.at(-1)!.seq, tail: entries.at(-1)!.entryHash,
});

const actor = (userId: string): YoloActor => ({ organizationId: ORG, userId, role: "owner", kind: "web" });

await withDisposablePostgres("ohb159_yolo_link", async ({ owner, connect }) => {
  const api = await connect("ohb_api");
  const worker = await connect("ohb_worker");
  const deps: YoloLeaseDeps = {
    signer: createYoloLeaseSigner({ seed: TEST_SEED, previousSeeds: [] }),
    publisher: NO_YOLO_PUBLISHER,
    readPolicy: (tx, organizationId) => readOrganizationPermissionPolicy(tx, organizationId),
  };
  const grant = (body: Record<string, unknown>) => grantYoloLease(api, deps, actor(OWNER), readYoloGrantInput({ acknowledged: true, ...body }));
  const store = createLinkLivenessStore(api, { webAppUrl: "https://openedbot.app" });
  const link: LinkIdentity = { runtimeId: RUNTIME, organizationId: ORG, tokenHash: TOKEN, expiresAt: null };

  for (const [user, email] of [[OWNER, "owner@example.com"], [ADMIN, "admin@example.com"], [OUTSIDER, "outsider@example.com"]] as const) {
    await owner`insert into users (id, email) values (${user}, ${email})`;
  }
  for (const [org, slug] of [[ORG, "yolo-link"], [OTHER, "yolo-link-other"]] as const) {
    await owner`insert into organizations (id, slug, name, permission_pipeline) values (${org}, ${slug}, 'Acme', 'v2')`;
  }
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${ADMIN}, 'admin'), (${OTHER}, ${OUTSIDER}, 'owner')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Acme', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode, hermes_profile) values
    (${BOT}, ${ORG}, ${SECTION}, 'Designer', 'designer', 0, 'manual', 'designer')`;
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, link_token_hash, link_features, link_connected_at, last_health_status) values
    (${RUNTIME}, ${ORG}, 'Mac', 'connector', true, ${TOKEN}, '{yolo_lease,yolo_thread_scope}', now(), 'healthy'),
    (${SIBLING}, ${ORG}, 'Linux', 'connector', false, ${SIBLING_TOKEN}, '{yolo_lease}', now(), 'healthy'),
    (${OTHER_RUNTIME}, ${OTHER}, 'Other', 'connector', true, ${"d".repeat(64)}, '{yolo_lease}', now(), 'healthy')`;
  const lease = async (leaseId: string) => (await owner<Array<{ hostState: string; reason: string | null; delivered: boolean; revoke: string | null; by: string | null }>>`
    select host_state as "hostState", host_state_reason as reason, delivered_at is not null as delivered, revoke_reason as revoke, revoked_by_user_id as by
      from permission_yolo_leases where id = ${leaseId}`)[0]!;

  // 1. yolo.state: delivery recorded, the missing live lease handed back, an unknown active one taken back.
  const runtimeLease = await grant({ scope: "runtime" });
  const unknown = id(299);
  const handedBack = await store.yoloState!(link, { t: "yolo.state", leases: [{ leaseId: unknown, status: "active" }] });
  assert(handedBack.redeliver.map((frame) => frame.lease.leaseId).join() === runtimeLease.id, `the missing lease was not handed back: ${JSON.stringify(handedBack)}`);
  const stored = (await owner<Array<{ signature: string }>>`select signature from permission_yolo_leases where id = ${runtimeLease.id}`)[0]!;
  assert(handedBack.redeliver[0]!.signature === stored.signature, "the handed-back lease is not the signed one");
  assert(handedBack.revoke.join() === unknown, "an active lease unknown here was not taken back");
  await store.yoloState!(link, { t: "yolo.state", leases: [{ leaseId: runtimeLease.id, status: "active" }] });
  const delivered = await lease(runtimeLease.id);
  assert(delivered.hostState === "active" && delivered.delivered, `the host state was not written: ${JSON.stringify(delivered)}`);

  // 2. Another runtime's token, a wrong token or another tenant write nothing and revoke nothing.
  assert(await refused(() => store.yoloState!({ ...link, tokenHash: SIBLING_TOKEN }, { t: "yolo.state", leases: [], killedAt: 4_000_000_000 }))
    === "YOLO runtime unavailable", "a foreign token wrote YOLO state");
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`select * from revoke_permission_yolo_leases_by_host(
    ${ORG}::uuid, ${RUNTIME}::uuid, ${SIBLING_TOKEN}, null, now(), 'host_cli')`)) === "42501", "the sibling's token revoked this runtime's leases");
  assert(await refused(() => asTenant(api, OTHER, (tx) => tx`select * from revoke_permission_yolo_leases_by_host(
    ${ORG}::uuid, ${RUNTIME}::uuid, ${TOKEN}, null, now(), 'host_cli')`)) === "42501", "another tenant revoked through the host function");
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`select * from revoke_permission_yolo_leases_by_host(
    ${ORG}::uuid, ${RUNTIME}::uuid, ${TOKEN}, null, now(), 'kill_switch')`)) === "22023", "a human revocation reason went through the host function");
  assert(await refused(() => asTenant(worker, ORG, (tx) => tx`select * from revoke_permission_yolo_leases_by_host(
    ${ORG}::uuid, ${RUNTIME}::uuid, ${TOKEN}, null, now(), 'host_cli')`)) === "42501", "the worker may call the host revocation");
  assert((await lease(runtimeLease.id)).revoke === null, "a refused host revocation revoked");

  // 3. yolo.audit: verified, idempotent, then a broken chain is quarantined, journaled and mailed.
  const first = chain(2, runtimeLease.id, null);
  const recorded = await store.yoloAudit!(link, frameOf(first));
  assert(recorded.outcome === "recorded" && recorded.inserted === 2, `a sound slice was not recorded: ${JSON.stringify(recorded)}`);
  const replay = await store.yoloAudit!(link, frameOf(first));
  assert(replay.outcome === "duplicate", `a replayed slice was not a duplicate: ${JSON.stringify(replay)}`);
  const next = chain(2, runtimeLease.id, { seq: 2, hash: first[1]!.entryHash });
  assert((await store.yoloAudit!(link, frameOf([...first, ...next]))).outcome === "recorded", "an overlapping slice did not record its new entries");
  assert((await owner`select 1 from permission_yolo_audit where runtime_id = ${RUNTIME}`).length === 4, "the audit does not hold exactly four entries");
  const forked = chain(2, runtimeLease.id, { seq: 4, hash: "9".repeat(64) });
  const quarantined = await store.yoloAudit!(link, frameOf(forked));
  assert(quarantined.outcome === "quarantined" && quarantined.reason === "prev_mismatch" && quarantined.brokenSeq === 5,
    `a broken chain was not quarantined: ${JSON.stringify(quarantined)}`);
  assert((await owner`select 1 from permission_yolo_audit where runtime_id = ${RUNTIME}`).length === 4, "a broken slice reached the audit");
  const kept = (await owner<Array<{ fromSeq: string; reason: string; entries: unknown }>>`
    select from_seq::text as "fromSeq", reason, entries from permission_yolo_audit_quarantine where runtime_id = ${RUNTIME}`);
  assert(kept.length === 1 && kept[0]!.fromSeq === "5" && kept[0]!.reason === "prev_mismatch"
    && JSON.stringify(kept[0]!.entries).includes(forked[0]!.entryHash), `the quarantine does not hold the slice: ${JSON.stringify(kept)}`);
  assert((await owner`select 1 from runtime_link_events where runtime_id = ${RUNTIME} and kind = 'anchor_tampered' and meta ->> 'reason' = 'yolo_audit_prev_mismatch'`).length === 1,
    "the broken chain was not journaled");
  const mails = await owner<Array<{ email: string }>>`select recipient_email as email from email_outbox where kind = 'yolo_audit_quarantined' order by 1`;
  assert(mails.map((mail) => mail.email).join() === "admin@example.com,owner@example.com", `owners and admins were not told: ${JSON.stringify(mails)}`);
  // Chained on the kept slice, the host's next entries go back to the audit; a second break within the hour mails nobody again.
  const resumed = chain(1, runtimeLease.id, { seq: 6, hash: forked[1]!.entryHash });
  assert((await store.yoloAudit!(link, frameOf(resumed))).outcome === "recorded", "the audit did not resume after a quarantine");
  assert((await store.yoloAudit!(link, frameOf(chain(1, id(298), { seq: 7, hash: resumed[0]!.entryHash })))).outcome === "quarantined",
    "an entry under a lease this runtime never had was recorded");
  assert((await owner`select 1 from email_outbox where kind = 'yolo_audit_quarantined'`).length === 2, "a second quarantine within the hour mailed again");

  // 4. The quarantine is append-only and tenant scoped.
  assert(await refused(() => owner`update permission_yolo_audit_quarantine set reason = 'conflict'`) === "42501", "the quarantine was rewritten");
  assert(await refused(() => asTenant(api, ORG, (tx) => tx`delete from permission_yolo_audit_quarantine`)) === "42501", "the API deleted the quarantine");
  assert((await asTenant(api, OTHER, (tx) => tx`select 1 from permission_yolo_audit_quarantine`)).length === 0, "a tenant read another's quarantine");
  assert((await worker`select 1 from permission_yolo_audit_quarantine`).length === 0, "an unbound worker read every quarantine");
  assert((await asTenant(worker, ORG, (tx) => tx`select 1 from permission_yolo_audit_quarantine`)).length === 2, "the bound worker cannot read its quarantine");

  // 5. The host kill: leases issued up to killedAt are revoked here (host_cli, no human), a later one stays.
  const revision = async () => Number((await owner<Array<{ r: string }>>`select permission_revision as r from bots where id = ${BOT}`)[0]!.r);
  const botLease = await grant({ scope: "bot", botId: BOT });
  const issuedAt = Math.floor(new Date(botLease.issuedAt).getTime() / 1000);
  await store.yoloState!(link, { t: "yolo.state", leases: [], killedAt: issuedAt - 60 });
  assert((await lease(botLease.id)).revoke === null, "a kill older than the lease revoked it");
  const before = await revision();
  const killed = await store.yoloState!(link, { t: "yolo.state", leases: [], killedAt: issuedAt + 60 });
  const afterKill = await lease(botLease.id);
  assert(killed.revokedByHost === 2 && afterKill.revoke === "host_cli" && afterKill.by === null
    && afterKill.hostState === "revoked" && afterKill.reason === "host_kill", `the host kill was not applied: ${JSON.stringify({ killed, afterKill })}`);
  assert((await lease(runtimeLease.id)).revoke === "host_cli", "the kill spared a lease issued before it");
  assert(await revision() === before + 1, "the host kill did not raise the bot revision");

  // 6. A host refusal revokes the lease here.
  const refusedLease = await grant({ scope: "runtime" });
  await store.yoloState!(link, { t: "yolo.state", leases: [{ leaseId: refusedLease.id, status: "rejected", reason: "key_unknown" }] });
  const rejected = await lease(refusedLease.id);
  assert(rejected.revoke === "host_rejected" && rejected.hostState === "rejected" && rejected.reason === "key_unknown",
    `a host refusal was not applied: ${JSON.stringify(rejected)}`);

  // 7. The worker pass: an elapsed lease marked expired, an undelivered one pushed, a revocation the host still ignores pushed again.
  await owner`insert into permission_yolo_leases (id, organization_id, runtime_id, scope, granted_by_user_id, issued_at, not_before, expires_at, key_id, signature, payload)
    values (${id(280)}, ${ORG}, ${SIBLING}, 'runtime', ${OWNER}, now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour',
            ${"0".repeat(32)}, ${`${"A".repeat(86)}==`}, '{}'::jsonb)`;
  const pending = await grant({ scope: "runtime" });
  const ignored = await grant({ scope: "bot", botId: BOT });
  await store.yoloState!(link, { t: "yolo.state", leases: [{ leaseId: pending.id, status: "active" }, { leaseId: ignored.id, status: "active" }] });
  await owner`update permission_yolo_leases set delivered_at = null, host_state = 'pending', host_state_reason = null, host_state_at = null where id = ${pending.id}`;
  await revokeYoloLease(api, deps, actor(OWNER), ignored.id);
  const pushes: Array<{ runtimeId: string; frame: { t: string; leaseId?: string; lease?: { leaseId: string } } }> = [];
  resetYoloLeaseSync();
  const pass = await syncYoloLeases(worker, {
    apiInternalUrl: "http://api.invalid", apiInternalToken: "internal-token", firstRetryAfterSeconds: 0,
    fetchImpl: async (url, init) => {
      pushes.push({ runtimeId: decodeURIComponent(url.split("/").at(-2)!), frame: (JSON.parse(String(init?.body)) as { frame: never }).frame });
      return Response.json({ pushed: true });
    },
  });
  assert(pass.expired === 1 && (await lease(id(280))).hostState === "expired", `the elapsed lease was not marked: ${JSON.stringify(pass)}`);
  const pushed = pushes.map(({ frame }) => `${frame.t}:${frame.leaseId ?? frame.lease?.leaseId}`).sort();
  assert(JSON.stringify(pushed) === JSON.stringify([`yolo.lease:${pending.id}`, `yolo.revoke:${ignored.id}`].sort()) && pass.pushed === 2,
    `the worker did not push exactly what was due: ${JSON.stringify(pushed)}`);
  assert(pushes.every((push) => push.runtimeId === RUNTIME), "the worker pushed to another runtime");
});

console.log("yolo-link-ingest integration: host state, host kill, host refusal, audit chain, quarantine and worker re-push hold on PostgreSQL.");
