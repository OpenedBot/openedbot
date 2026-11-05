/**
 * DEV-308 against a disposable PostgreSQL database and the local fake APNs
 * (never Apple): device registration over the real HTTP routes (idempotence,
 * token update, collisions across members and organizations, RLS, revocation
 * on DELETE, logout and member removal), then the worker half (fan-out from
 * `push_outbox`, exact payload and headers, exactly once per device, 410
 * revocation, bounded 429 retries, recovery after a worker crash).
 */
import { SQL } from "bun";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { secretEncryptionKey } from "../../platform/hermes/src/secrets";
import type { ApnsConfig } from "../../platform/integrations/src/apns";
import { HttpError } from "../../contracts/errors/src/http-error";
import { protectedAuthRoutes, type AppVariables, type AuthContext } from "../../apps/api/src/routes/identity/auth";
import { apnsDeviceRoutes } from "../../apps/api/src/routes/notifications/apns-device-routes";
import { processPushNotifications } from "../../modules/notifications/src/application/push-notifications";
import { APNS_MAX_ATTEMPTS, processApnsDeliveries } from "../../modules/notifications/src/application/apns-deliveries";
import { createApnsTransport } from "../../modules/notifications/src/application/apns-transport";
import { claimApnsDelivery } from "../../modules/notifications/src/sql/apns-devices";
import { removeMember } from "../../modules/identity/src/application/members";
import { startFakeApns, type FakeApnsDelivery } from "../fake-apns/server";

const root = resolve(import.meta.dir, "../..");
const id = (n: number) => `a1080000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id(1);
const ORG_B = id(2);
const OWNER_A = id(11);
const MEMBER_A = id(12);
const OWNER_B = id(13);
const SECTION_A = id(21);
const SECTION_B = id(22);
const BOT_A = id(31);
const BOT_B = id(32);
const GROUP_A = id(41);
const DM_THREAD = id(51);
const GROUP_THREAD = id(52);
const THREAD_B = id(53);
const BUNDLE = "app.openedbot.mobile";
const T1 = randomBytes(32).toString("hex");
const T2 = randomBytes(32).toString("hex");
const T3 = randomBytes(32).toString("hex");
const SECRET_OUTPUT = "FINAL OUTPUT MUST NEVER LEAVE";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`PostgreSQL discovery failed (${command[0]}): ${error}`);
  return output.trimEnd();
}

async function adminUrl(): Promise<URL> {
  if (process.env.INTEGRATION_ADMIN_DATABASE_URL) return new URL(process.env.INTEGRATION_ADMIN_DATABASE_URL);
  const container = process.env.OPENEDBOT_POSTGRES_CONTAINER ?? "infra-postgres";
  const port = (await capture(["docker", "port", container, "5432/tcp"]))
    .split("\n").find((line) => line.startsWith("127.0.0.1:") || line.startsWith("0.0.0.0:"))?.split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("Existing PostgreSQL must expose a loopback port, or supply INTEGRATION_ADMIN_DATABASE_URL.");
  const credentials = await capture(["docker", "exec", container, "sh", "-ceu", 'printf "%s\\n%s" "$POSTGRES_USER" "$POSTGRES_PASSWORD"']);
  const newline = credentials.indexOf("\n");
  if (newline < 1) throw new Error("Existing PostgreSQL credentials are unavailable.");
  const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
  url.username = credentials.slice(0, newline);
  url.password = credentials.slice(newline + 1);
  return url;
}

function databaseUrl(source: URL, database: string, username: string, password: string): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  url.username = username;
  url.password = password;
  return url.toString();
}

const keyring = { current: secretEncryptionKey(new Uint8Array(randomBytes(32))), previous: [] };
const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
const fake = await startFakeApns({ port: 0, publicKey: signing.publicKey, keyId: "KEYID00108", teamId: "TEAMID0108" });
const apns: ApnsConfig = {
  keyId: "KEYID00108",
  teamId: "TEAMID0108",
  privateKey: signing.privateKey,
  bundleIds: [BUNDLE],
  hostOverride: fake.url,
};
const transport = createApnsTransport(apns, { timeoutMs: 2_000 });

const source = await adminUrl();
const database = `openedbot108_apns_${crypto.randomUUID().replaceAll("-", "")}`;
const adminDb = new SQL({ url: source.toString(), max: 1 });
let target: SQL | null = null;
let api: SQL | null = null;
let worker: SQL | null = null;
let databaseCreated = false;

function authOf(organizationId: string, userId: string, role: AuthContext["role"] = "owner"): AuthContext {
  return { sessionId: id(900), organizationId, userId, role, kind: "native", credentialHash: "integration" };
}

function app(db: SQL, auth: AuthContext): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  routes.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  routes.route("/api/push/apns", apnsDeviceRoutes(db, { apns: { bundleIds: apns.bundleIds }, tokenEncryption: keyring }));
  routes.route("/api/auth", protectedAuthRoutes(db));
  return routes;
}

async function register(auth: AuthContext, installation: string, token: string, environment = "sandbox"): Promise<Response> {
  return app(api!, auth).request(`/api/push/apns/devices/${installation}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, bundleId: BUNDLE, environment }),
  });
}

async function read(auth: AuthContext, installation: string): Promise<{ status: number; body: unknown }> {
  const response = await app(api!, auth).request(`/api/push/apns/devices/${installation}`);
  return { status: response.status, body: await response.json() };
}

type DeviceRow = {
  id: string;
  organizationId: string;
  userId: string;
  installationId: string;
  tokenHash: string;
  ciphertext: string | null;
  revokedReason: string | null;
};

async function devices(): Promise<DeviceRow[]> {
  return target!<DeviceRow[]>`
    select id, organization_id as "organizationId", user_id as "userId", installation_id as "installationId",
           token_hash as "tokenHash", token_ciphertext as ciphertext, revoked_reason as "revokedReason"
      from apns_devices order by created_at, id
  `;
}

let workflowCounter = 0;
/** One workflow driven to `status`: the 0039 trigger writes the push_outbox row. */
async function transition(input: {
  kind: "dm" | "group" | "routine";
  threadId: string;
  status: "awaiting_approval" | "completed" | "failed";
  organizationId?: string;
  botId?: string;
}): Promise<string> {
  workflowCounter += 1;
  const workflowId = id(5_000 + workflowCounter);
  const runId = id(6_000 + workflowCounter);
  const organizationId = input.organizationId ?? ORG_A;
  const botId = input.botId ?? BOT_A;
  await target!.begin(async (tx) => {
    await tx`insert into workflows (id, organization_id, thread_id, root_run_id, root_bot_id, kind, final_output)
      values (${workflowId}, ${organizationId}, ${input.threadId}, ${runId}, ${botId}, ${input.kind}, ${SECRET_OUTPUT})`;
    await tx`insert into runs (id, organization_id, thread_id, bot_id, input, status, workflow_id, step_index, step_kind)
      values (${runId}, ${organizationId}, ${input.threadId}, ${botId}, 'secret prompt', 'completed', ${workflowId}, 0, 'root')`;
  });
  await target!`update workflows set status = 'running' where id = ${workflowId}`;
  await target!`update workflows set status = ${input.status} where id = ${workflowId}`;
  return workflowId;
}

async function drain(): Promise<void> {
  await processPushNotifications(worker!, { vapid: null, apns, workerId: "integration-worker" });
  await processApnsDeliveries(worker!, { apns, tokenEncryption: keyring, workerId: "integration-worker" }, transport);
}

function journalFor(token: string): FakeApnsDelivery[] {
  return fake.journal().filter((delivery) => delivery.token === token);
}

try {
  await adminDb.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = 'openedbot_api') then create role openedbot_api login password 'openedbot_api_dev' nosuperuser nocreatedb nocreaterole; end if;
    if not exists (select from pg_roles where rolname = 'openedbot_worker') then create role openedbot_worker login password 'openedbot_worker_dev' nosuperuser nocreatedb nocreaterole; end if;
  end $$`);
  await adminDb.unsafe(`create database "${database}"`);
  databaseCreated = true;
  await adminDb.unsafe(`grant connect on database "${database}" to openedbot_api, openedbot_worker`);

  target = new SQL({ url: databaseUrl(source, database, source.username, source.password), max: 1 });
  for (const migration of (await readdir(resolve(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await target.unsafe(await Bun.file(resolve(root, "db/migrations", migration)).text());
  }

  await target`insert into organizations (id, slug, name) values (${ORG_A}, 'apns-a', 'APNs A'), (${ORG_B}, 'apns-b', 'APNs B')`;
  await target`insert into users (id, email) values
    (${OWNER_A}, 'apns-owner-a@example.test'), (${MEMBER_A}, 'apns-member-a@example.test'), (${OWNER_B}, 'apns-owner-b@example.test')`;
  await target`insert into memberships (organization_id, user_id, role) values
    (${ORG_A}, ${OWNER_A}, 'owner'), (${ORG_A}, ${MEMBER_A}, 'member'), (${ORG_B}, ${OWNER_B}, 'owner')`;
  await target`insert into sections (id, organization_id, name, position) values
    (${SECTION_A}, ${ORG_A}, 'A', 0), (${SECTION_B}, ${ORG_B}, 'B', 0)`;
  await target`insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position) values
    (${BOT_A}, ${ORG_A}, ${SECTION_A}, 'Atlas', 'atlas', 'atlas', 0),
    (${BOT_B}, ${ORG_B}, ${SECTION_B}, 'Borealis', 'borealis', 'borealis', 0)`;
  await target`insert into bot_groups (id, organization_id, section_id, name, position) values (${GROUP_A}, ${ORG_A}, ${SECTION_A}, 'Salon Nord', 0)`;
  await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default) values
    (${DM_THREAD}, ${ORG_A}, ${BOT_A}, 'secret thread title', 'apns:dm', true),
    (${THREAD_B}, ${ORG_B}, ${BOT_B}, 'B thread', 'apns:b', true)`;
  await target`insert into threads (id, organization_id, group_id, title, hermes_session_id) values
    (${GROUP_THREAD}, ${ORG_A}, ${GROUP_A}, 'secret group title', 'apns:group')`;

  api = new SQL({ url: databaseUrl(source, database, "openedbot_api", "openedbot_api_dev"), max: 2 });
  worker = new SQL({ url: databaseUrl(source, database, "openedbot_worker", "openedbot_worker_dev"), max: 2 });
  const ownerA = authOf(ORG_A, OWNER_A);
  const memberA = authOf(ORG_A, MEMBER_A, "member");
  const ownerB = authOf(ORG_B, OWNER_B);

  // ---------------------------------------------------------- registration ---
  const first = await register(ownerA, "install-1", T1.toUpperCase());
  assert(first.status === 200, `first registration must be 200, got ${first.status}`);
  const firstBody = await first.json() as Record<string, unknown>;
  assert(
    JSON.stringify(Object.keys(firstBody).sort()) === '["enabled","installationId","lastRegisteredAt"]'
      && firstBody.installationId === "install-1" && firstBody.enabled === true
      && typeof firstBody.lastRegisteredAt === "string",
    `PUT answer shape: ${JSON.stringify(firstBody)}`,
  );
  let rows = await devices();
  assert(rows.length === 1, "one row after the first registration");
  assert(rows[0]!.tokenHash === createHash("sha256").update(T1).digest("hex"), "the hash is the SHA-256 of the lower-case token");
  assert(rows[0]!.ciphertext && !rows[0]!.ciphertext.includes(T1), "the token is stored encrypted");
  const firstRowId = rows[0]!.id;

  assert((await register(ownerA, "install-1", T1)).status === 200, "re-registration is idempotent");
  assert((await register(ownerA, "install-1", T2)).status === 200, "a token change re-registers in place");
  rows = await devices();
  assert(rows.length === 1 && rows[0]!.id === firstRowId, "same installation keeps one row");
  assert(rows[0]!.tokenHash === createHash("sha256").update(T2).digest("hex"), "the token was updated");

  const state = await read(ownerA, "install-1");
  assert(state.status === 200, "GET of a registered device is 200");
  assert(
    JSON.stringify(Object.keys(state.body as object).sort()) === '["enabled","lastRegisteredAt"]'
      && (state.body as { enabled: boolean }).enabled === true,
    `GET answer shape: ${JSON.stringify(state.body)}`,
  );
  assert(!JSON.stringify(state.body).includes(T2), "GET never returns the token");

  // Same token moved to another member of the same organization.
  assert((await register(memberA, "install-2", T2)).status === 200, "member A registers the moved token");
  assert((await read(ownerA, "install-1")).body && (await read(ownerA, "install-1") as { body: { enabled: boolean } }).body.enabled === false,
    "the previous holder of a moved token is disabled");
  rows = await devices();
  const moved = rows.find((row) => row.userId === OWNER_A)!;
  assert(moved.revokedReason === "token_moved" && moved.ciphertext === null, "a moved token is erased from the old row");

  // Same token moved across organizations: the definer trigger crosses tenants.
  assert((await register(ownerB, "install-b", T3)).status === 200, "owner B registers");
  assert((await register(ownerA, "install-1", T3)).status === 200, "owner A takes the token of B");
  rows = await devices();
  assert(rows.find((row) => row.userId === OWNER_B)?.revokedReason === "token_moved", "the other tenant registration was revoked");
  assert(rows.find((row) => row.userId === OWNER_A)?.revokedReason === null, "owner A is active again");

  // RLS: a member sees only their devices in the current organization.
  const visible = await api.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${ORG_A}, true)`;
    await tx`select set_config('app.authenticating_user_id', ${OWNER_A}, true)`;
    return tx<Array<{ userId: string; organizationId: string }>>`select user_id as "userId", organization_id as "organizationId" from apns_devices`;
  });
  assert(visible.length === 1 && visible[0]!.userId === OWNER_A, `API RLS must show one own row, got ${JSON.stringify(visible)}`);
  let forgedDenied = false;
  try {
    await api.begin(async (tx) => {
      await tx`select set_config('app.organization_id', ${ORG_A}, true)`;
      await tx`select set_config('app.authenticating_user_id', ${OWNER_A}, true)`;
      await tx`insert into apns_devices (organization_id, user_id, installation_id, bundle_id, environment, token_hash, token_ciphertext, token_nonce, token_tag, token_key_id)
        values (${ORG_A}, ${MEMBER_A}, 'forged', ${BUNDLE}, 'sandbox', ${"0".repeat(64)}, 'c', 'n', 't', 'k')`;
    });
  } catch (error) {
    const details = error && typeof error === "object"
      ? error as { errno?: unknown; message?: unknown }
      : null;
    if (details?.errno !== "42501" || typeof details.message !== "string"
      || !details.message.includes("row-level security policy")) throw error;
    forgedDenied = true;
  }
  assert(forgedDenied, "an API caller cannot write a device for another member");
  const workerBlind = await worker`select count(*)::int as count from apns_devices`;
  assert(workerBlind[0]?.count === 0, "the worker reads no device without a tenant");
  const workerA = await worker.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${ORG_A}, true)`;
    return tx<Array<{ organizationId: string }>>`select organization_id as "organizationId" from apns_devices`;
  });
  assert(workerA.length > 0 && workerA.every((row) => row.organizationId === ORG_A), "the worker reads the devices of its tenant only");

  // DELETE: 204, then 404 on read, then 204 again.
  const removed = await app(api, ownerB).request("/api/push/apns/devices/install-b", { method: "DELETE" });
  assert(removed.status === 204, "DELETE is 204");
  const gone = await read(ownerB, "install-b");
  assert(gone.status === 404 && (gone.body as { error: { code: string } }).error.code === "APNS_DEVICE_NOT_FOUND", "GET after DELETE is 404");
  assert((await app(api, ownerB).request("/api/push/apns/devices/install-b", { method: "DELETE" })).status === 204, "DELETE again is 204");

  // Native logout with the installation removes the device, then the session.
  assert((await register(ownerB, "install-b", T3)).status === 200, "owner B registers again");
  const logout = await app(api, ownerB).request("/api/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ installationId: "install-b" }),
  });
  assert(logout.status === 204, `logout is 204, got ${logout.status}`);
  assert((await read(ownerB, "install-b")).status === 404, "logout removed the installation");

  // ------------------------------------------------------------- delivery ---
  // T1 on owner A (sandbox), T2 on member A (production).
  assert((await register(ownerA, "install-1", T1)).status === 200, "owner A on T1");
  assert((await register(memberA, "install-2", T2, "production")).status === 200, "member A on T2");

  const routine = await transition({ kind: "routine", threadId: DM_THREAD, status: "completed" });
  await drain();
  const routineDeliveries = await target<Array<{ id: string; status: string; attempts: number }>>`
    select d.id, d.status, d.attempts from apns_deliveries d
      join push_outbox o on o.id = d.outbox_id where o.workflow_id = ${routine}`;
  assert(routineDeliveries.length === 2 && routineDeliveries.every((row) => row.status === "sent" && row.attempts === 1),
    `two sent deliveries for the routine, got ${JSON.stringify(routineDeliveries)}`);
  const outboxStatus = await target<Array<{ status: string }>>`select status from push_outbox where workflow_id = ${routine}`;
  assert(outboxStatus[0]?.status === "sent", "the outbox row handed to APNs is sent even without Web Push");
  const [toOwner] = journalFor(T1);
  assert(toOwner, "the fake received the owner delivery");
  assert(toOwner.topic === BUNDLE && toOwner.pushType === "alert" && toOwner.priority === "5"
    && toOwner.collapseId === `workflow:${routine}` && routineDeliveries.some((row) => row.id === toOwner.apnsId),
    `headers: ${JSON.stringify(toOwner)}`);
  assert(JSON.stringify(toOwner.payload) === JSON.stringify({
    aps: { alert: { title: "Atlas", body: "Routine terminée" }, sound: "default", "thread-id": DM_THREAD },
    openedbot: { kind: "workflow", threadId: DM_THREAD, organizationId: ORG_A },
  }), `payload: ${JSON.stringify(toOwner.payload)}`);
  assert(!JSON.stringify(fake.journal()).includes(SECRET_OUTPUT) && !JSON.stringify(fake.journal()).includes("secret"),
    "no workflow output, prompt or thread title leaves");

  // Exactly once: replays add nothing.
  const sentBefore = fake.journal().length;
  await drain();
  await drain();
  assert(fake.journal().length === sentBefore, "a replayed pass sends nothing again");

  // Approval in a group: group name, priority 10, collapse per transition.
  const approval = await transition({ kind: "group", threadId: GROUP_THREAD, status: "awaiting_approval" });
  await drain();
  const approvalToOwner = journalFor(T1).at(-1)!;
  const sequence = await target<Array<{ seq: string }>>`select notification_sequence::text as seq from workflows where id = ${approval}`;
  assert(approvalToOwner.priority === "10" && approvalToOwner.collapseId === `approval:${approval}:${sequence[0]!.seq}`,
    `approval headers: ${JSON.stringify(approvalToOwner)}`);
  assert(JSON.stringify(approvalToOwner.payload) === JSON.stringify({
    aps: { alert: { title: "Salon Nord", body: "Approbation en attente" }, sound: "default", "thread-id": GROUP_THREAD },
    openedbot: { kind: "approval", threadId: GROUP_THREAD, organizationId: ORG_A },
  }), `approval payload: ${JSON.stringify(approvalToOwner.payload)}`);

  // Another tenant's transition never reaches tenant A devices.
  const beforeB = fake.journal().length;
  await transition({ kind: "routine", threadId: THREAD_B, status: "completed", organizationId: ORG_B, botId: BOT_B });
  await drain();
  assert(fake.journal().length === beforeB, "tenant B has no device: nothing sent");

  // A muted bot (0099) does not ring on finish.
  await target`update bots set notify_on_finish = false where id = ${BOT_A}`;
  const beforeMute = fake.journal().length;
  await transition({ kind: "routine", threadId: DM_THREAD, status: "completed" });
  await drain();
  assert(fake.journal().length === beforeMute, "a muted bot sends no APNs");
  await target`update bots set notify_on_finish = true where id = ${BOT_A}`;

  // 410 Unregistered revokes the device; the client sees enabled: false.
  fake.script({ status: 410, reason: "Unregistered", token: T2 });
  await transition({ kind: "routine", threadId: DM_THREAD, status: "failed" });
  await drain();
  const memberDevice = (await devices()).find((row) => row.userId === MEMBER_A)!;
  assert(memberDevice.revokedReason === "unregistered" && memberDevice.ciphertext === null, "410 revokes and erases the device");
  assert((await read(memberA, "install-2") as { body: { enabled: boolean } }).body.enabled === false, "GET says enabled: false");
  const revokedDelivery = await target<Array<{ status: string; lastHttpStatus: number; lastReason: string }>>`
    select status, last_http_status as "lastHttpStatus", last_reason as "lastReason"
      from apns_deliveries where device_id = ${memberDevice.id} order by created_at desc limit 1`;
  assert(revokedDelivery[0]?.status === "revoked" && revokedDelivery[0].lastHttpStatus === 410
    && revokedDelivery[0].lastReason === "Unregistered", `revoked delivery: ${JSON.stringify(revokedDelivery)}`);

  // 429 is retried with backoff, then abandoned after APNS_MAX_ATTEMPTS.
  fake.script({ status: 429, reason: "TooManyRequests", token: T1, times: APNS_MAX_ATTEMPTS });
  const throttled = await transition({ kind: "routine", threadId: DM_THREAD, status: "completed" });
  const throttledBefore = journalFor(T1).length;
  await drain();
  const afterFirst = await target<Array<{ status: string; attempts: number; future: boolean; lastHttpStatus: number }>>`
    select d.status, d.attempts, d.available_at > now() as future, d.last_http_status as "lastHttpStatus"
      from apns_deliveries d join push_outbox o on o.id = d.outbox_id where o.workflow_id = ${throttled}`;
  assert(afterFirst[0]?.status === "pending" && afterFirst[0].attempts === 1 && afterFirst[0].future && afterFirst[0].lastHttpStatus === 429,
    `a 429 waits for its backoff: ${JSON.stringify(afterFirst)}`);
  for (let attempt = 2; attempt <= APNS_MAX_ATTEMPTS + 2; attempt += 1) {
    await target`update apns_deliveries set available_at = now() where status = 'pending'`;
    await drain();
  }
  const abandoned = await target<Array<{ status: string; attempts: number; lastReason: string }>>`
    select d.status, d.attempts, d.last_reason as "lastReason"
      from apns_deliveries d join push_outbox o on o.id = d.outbox_id where o.workflow_id = ${throttled}`;
  assert(abandoned[0]?.status === "failed" && abandoned[0].attempts === APNS_MAX_ATTEMPTS && abandoned[0].lastReason === "TooManyRequests",
    `abandoned after the bound: ${JSON.stringify(abandoned)}`);
  assert(journalFor(T1).length - throttledBefore === APNS_MAX_ATTEMPTS, "exactly APNS_MAX_ATTEMPTS requests reached APNs");

  // Worker crash after the claim: the lease expires and the same apns-id goes out once.
  const crashed = await transition({ kind: "routine", threadId: DM_THREAD, status: "completed" });
  await processPushNotifications(worker, { vapid: null, apns, workerId: "integration-worker" });
  const ghost = await claimApnsDelivery(worker, { workerId: "dead-worker", leaseSeconds: 60, maxAttempts: APNS_MAX_ATTEMPTS });
  assert(ghost, "the dead worker claimed the delivery");
  await processApnsDeliveries(worker, { apns, tokenEncryption: keyring, workerId: "integration-worker" }, transport);
  assert(!journalFor(T1).some((delivery) => delivery.apnsId === ghost.id), "a live lease is never stolen");
  await target`update apns_deliveries set lease_expires_at = now() - interval '1 second' where id = ${ghost.id}`;
  await processApnsDeliveries(worker, { apns, tokenEncryption: keyring, workerId: "integration-worker" }, transport);
  const recovered = await target<Array<{ status: string; attempts: number }>>`select status, attempts from apns_deliveries where id = ${ghost.id}`;
  assert(recovered[0]?.status === "sent" && recovered[0].attempts === 2, `recovered after the lease: ${JSON.stringify(recovered)}`);
  assert(journalFor(T1).filter((delivery) => delivery.apnsId === ghost.id && delivery.status === 200).length === 1,
    "the recovered delivery reached APNs once");
  const crashedOutbox = await target<Array<{ status: string }>>`select status from push_outbox where workflow_id = ${crashed}`;
  assert(crashedOutbox[0]?.status === "sent", "the outbox row is settled");

  // A lease that dies on the last allowed attempt is recorded, never re-sent.
  await transition({ kind: "routine", threadId: DM_THREAD, status: "completed" });
  await processPushNotifications(worker, { vapid: null, apns, workerId: "integration-worker" });
  await target`update apns_deliveries set status = 'sending', attempts = ${APNS_MAX_ATTEMPTS}, lease_owner = 'dead-worker',
    lease_expires_at = now() - interval '1 second' where status = 'pending'`;
  const exhaustedBefore = fake.journal().length;
  await processApnsDeliveries(worker, { apns, tokenEncryption: keyring, workerId: "integration-worker" }, transport);
  const exhausted = await target<Array<{ count: number }>>`select count(*)::int as count from apns_deliveries where last_reason = 'LeaseExpired' and status = 'failed'`;
  assert(exhausted[0]?.count === 1 && fake.journal().length === exhaustedBefore, "an exhausted lease is failed without a send");

  // Cap: 20 registrations per member; revoked ones are dropped to make room.
  for (let n = 0; n < 25; n += 1) {
    const status = (await register(ownerB, `cap-${n}`, n % 2 === 0 ? T3 : T2)).status;
    assert(status === 200, `bouncing a token across installations stays bounded, got ${status} at ${n}`);
  }
  const ownerBRows = (await devices()).filter((row) => row.userId === OWNER_B);
  assert(ownerBRows.length <= 20, `revoked registrations are bounded, got ${ownerBRows.length}`);
  let full: Response | null = null;
  for (let n = 0; n < 25 && !full; n += 1) {
    const response = await register(ownerB, `fill-${n}`, randomBytes(32).toString("hex"));
    if (response.status !== 200) full = response;
  }
  assert(full && full.status === 409 && ((await full.json()) as { error: { code: string } }).error.code === "APNS_DEVICE_LIMIT",
    "past the cap, a registration is refused with APNS_DEVICE_LIMIT");
  const activeB = (await devices()).filter((row) => row.userId === OWNER_B && row.revokedReason === null);
  assert(activeB.length === 20, `the cap is 20 active registrations once revoked ones are dropped, got ${activeB.length}`);

  // Member removal: the membership trigger drops the devices (and their deliveries).
  assert((await register(memberA, "install-2", T2, "production")).status === 200, "member A re-registers");
  await removeMember(api, { organizationId: ORG_A, actorUserId: OWNER_A, userId: MEMBER_A });
  assert(!(await devices()).some((row) => row.userId === MEMBER_A), "a removed member keeps no APNs device");

  console.log(JSON.stringify({
    event: "integration.apns_push",
    ok: true,
    requests: fake.journal().length,
    deliveries: (await target<Array<{ count: number }>>`select count(*)::int as count from apns_deliveries`)[0]?.count,
  }));
} finally {
  transport.close();
  await fake.stop();
  await api?.close();
  await worker?.close();
  await target?.close();
  if (databaseCreated) {
    await adminDb.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid()`);
    await adminDb.unsafe(`drop database if exists "${database}"`);
  }
  await adminDb.close();
}
