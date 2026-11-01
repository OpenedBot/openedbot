/** Prove 0087 against a disposable PostgreSQL database: alerts, recipients, RLS and staff functions. */
import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { withTenant, type Db, type TransactionDb } from "../../platform/db/src/db";

/** The staff GUC the SECURITY DEFINER alert functions read (the helper itself lives with the back office). */
function withStaffUser<T>(db: Db, staffUserId: string, callback: (tx: TransactionDb) => Promise<T>): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.staff_user_id', ${staffUserId}, true)`;
    return callback(tx);
  }) as Promise<T>;
}
import { evaluateRuntimeLinkAlerts } from "../../modules/runtime-link/src/application/link-alerts";

const root = resolve(import.meta.dir, "../..");
const organizationA = "87000000-0000-4000-8000-000000000001";
const organizationB = "87000000-0000-4000-8000-000000000002";
const pairer = "87000000-0000-4000-8000-000000000011";
const owner = "87000000-0000-4000-8000-000000000012";
const admin = "87000000-0000-4000-8000-000000000013";
const member = "87000000-0000-4000-8000-000000000014";
const downRuntime = "87000000-0000-4000-8000-000000000021";
const freshRuntime = "87000000-0000-4000-8000-000000000022";
const staleRuntime = "87000000-0000-4000-8000-000000000023";
const healthyRuntime = "87000000-0000-4000-8000-000000000024";
const staffId = "87000000-0000-4000-8000-000000000031";
const options = { downAfterMinutes: 5, webAppUrl: "https://console.ohb.test/", environment: "dev" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function capture(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
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

const source = await adminUrl();
const database = `ohb87_alerts_${crypto.randomUUID().replaceAll("-", "")}`;
const adminDb = new SQL({ url: source.toString(), max: 1 });
let target: SQL | null = null;
let api: SQL | null = null;
let worker: SQL | null = null;
let databaseCreated = false;

try {
  await adminDb.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = 'ohb_api') then create role ohb_api login password 'ohb_api_dev' nosuperuser nocreatedb nocreaterole; end if;
    if not exists (select from pg_roles where rolname = 'ohb_worker') then create role ohb_worker login password 'ohb_worker_dev' nosuperuser nocreatedb nocreaterole; end if;
  end $$`);
  await adminDb.unsafe(`create database "${database}"`);
  databaseCreated = true;
  await adminDb.unsafe(`grant connect on database "${database}" to ohb_api, ohb_worker`);

  target = new SQL({ url: databaseUrl(source, database, source.username, source.password), max: 1 });
  for (const migration of (await readdir(resolve(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await target.unsafe(await Bun.file(resolve(root, "db/migrations", migration)).text());
  }

  await target`insert into organizations (id, slug, name) values
      (${organizationA}, 'ohb87-a', 'OHB-87 A'),
      (${organizationB}, 'ohb87-b', 'OHB-87 B')`;
  await target`insert into users (id, email, display_name) values
      (${pairer}, 'ohb87-pairer@example.test', 'Pairer'),
      (${owner}, 'ohb87-owner@example.test', null),
      (${admin}, 'ohb87-admin@example.test', null),
      (${member}, 'ohb87-member@example.test', null)`;
  await target`insert into memberships (organization_id, user_id, role) values
      (${organizationA}, ${pairer}, 'member'),
      (${organizationA}, ${owner}, 'owner'),
      (${organizationA}, ${admin}, 'admin'),
      (${organizationA}, ${member}, 'member')`;
  await target`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, last_health_status, last_health_error, link_last_seen_at)
    values
      (${downRuntime}, ${organizationA}, 'VPS down', 'connector', 'ohb87-hash-down', false, 'disconnected', 'Aucun signe de vie du lien depuis 45 s.', now() - interval '10 minutes'),
      (${freshRuntime}, ${organizationA}, 'VPS blip', 'connector', 'ohb87-hash-fresh', false, 'disconnected', null, now() - interval '2 minutes'),
      (${staleRuntime}, ${organizationA}, 'Laptop off', 'connector', 'ohb87-hash-stale', false, 'disconnected', null, now() - interval '3 days'),
      (${healthyRuntime}, ${organizationB}, 'VPS fine', 'connector', 'ohb87-hash-fine', false, 'healthy', null, now())`;
  await target`insert into runtime_enrollments (id, secret_hash, runtime_name, verification_code, organization_id, claimed_by, claimed_at, consumed_at, runtime_id, expires_at, reachability)
    values (${crypto.randomUUID()}, 'ohb87-enrollment', 'VPS down', '000000', ${organizationA}, ${pairer}, now() - interval '1 day', now() - interval '1 day', ${downRuntime}, now() - interval '1 day', 'connector')`;
  await target`insert into staff_users (id, email, password_hash) values (${staffId}, 'ohb87-staff@example.test', 'not-a-real-hash')`;

  worker = new SQL({ url: databaseUrl(source, database, "ohb_worker", "ohb_worker_dev"), max: 1 });
  api = new SQL({ url: databaseUrl(source, database, "ohb_api", "ohb_api_dev"), max: 1 });

  // A worker that just started judges no link: after an openedbot outage every link
  // looks silent since the cut, while connectors come back within seconds.
  const justStarted = await evaluateRuntimeLinkAlerts(worker, { ...options, observingSince: new Date() });
  assert(justStarted.opened === 0 && justStarted.emails === 0, `a worker that just started opens nothing, got ${JSON.stringify(justStarted)}`);

  const first = await evaluateRuntimeLinkAlerts(worker, options);
  assert(first.opened === 2 && first.resolved === 0, `first pass must open the down and stale runtimes only, got ${JSON.stringify(first)}`);
  assert(first.emails === 3, `pairer, owner and admin must be emailed (not a plain member), got ${first.emails}`);

  const alerts = await target<Array<{ runtimeId: string; concernedUserId: string | null; notifiedAt: Date | null; notifiedRecipients: number }>>`
    select runtime_id as "runtimeId", concerned_user_id as "concernedUserId", notified_at as "notifiedAt", notified_recipients as "notifiedRecipients"
      from runtime_link_alerts order by runtime_name
  `;
  const down = alerts.find((alert) => alert.runtimeId === downRuntime);
  const stale = alerts.find((alert) => alert.runtimeId === staleRuntime);
  assert(down?.concernedUserId === pairer, "the concerned user is the one who paired the runtime");
  assert(down.notifiedAt && down.notifiedRecipients === 3, "the down alert records its three recipients");
  assert(stale && stale.notifiedAt === null && stale.notifiedRecipients === 0, "an outage older than 24 h is recorded without email");
  assert(!alerts.some((alert) => alert.runtimeId === freshRuntime), "a 2 minute outage is not an alert yet");

  const emails = await target<Array<{ recipient: string; dedupeKey: string; settingsUrl: string }>>`
    select recipient_email as recipient, dedupe_key as "dedupeKey", payload->>'settingsUrl' as "settingsUrl"
      from email_outbox where kind = 'runtime_link_down' order by recipient_email
  `;
  assert(emails.map((email) => email.recipient).join(",") === "ohb87-admin@example.test,ohb87-owner@example.test,ohb87-pairer@example.test", `unexpected recipients ${emails.map((email) => email.recipient)}`);
  assert(emails.every((email) => email.dedupeKey.startsWith("runtime_link_down:")), "dedupe keys are scoped to the alert");
  assert(emails.every((email) => email.settingsUrl === "https://console.ohb.test/o/ohb87-a/settings/runtime"), "settings URL targets the workspace slug");

  const replay = await evaluateRuntimeLinkAlerts(worker, options);
  assert(replay.opened === 0 && replay.emails === 0 && replay.resolved === 0, `a replayed pass is a no-op, got ${JSON.stringify(replay)}`);

  const tenantA = await withTenant(api, organizationA, (tx) => tx<Array<{ count: string }>>`select count(*)::text as count from runtime_link_alerts`);
  const tenantB = await withTenant(api, organizationB, (tx) => tx<Array<{ count: string }>>`select count(*)::text as count from runtime_link_alerts`);
  assert(tenantA[0]?.count === "2" && tenantB[0]?.count === "0", "RLS scopes alerts to their organization");

  let refused = false;
  try {
    await api`select * from staff_runtime_link_alerts('all', 10, null)`;
  } catch (error) {
    refused = (error as { errno?: string; code?: string }).errno === "42501" || String(error).includes("staff authentication required");
  }
  assert(refused, "staff functions refuse a caller without app.staff_user_id");

  const listed = await withStaffUser(api, staffId, (tx) => tx<Array<{ runtimeName: string; email: string | null }>>`
    select runtime_name as "runtimeName", concerned_user_email as email from staff_runtime_link_alerts('open', 10, null)
  `);
  assert(listed.length === 2 && listed.some((row) => row.email === "ohb87-pairer@example.test"), "staff lists open alerts with the concerned user");

  const alertId = (await target<Array<{ id: string }>>`select id from runtime_link_alerts where runtime_id = ${downRuntime}`)[0]!.id;
  const acknowledged = await withStaffUser(api, staffId, (tx) => tx<Array<{ at: Date }>>`select acknowledged_at as at from staff_acknowledge_runtime_link_alert(${alertId}::uuid)`);
  const again = await withStaffUser(api, staffId, (tx) => tx<Array<{ at: Date }>>`select acknowledged_at as at from staff_acknowledge_runtime_link_alert(${alertId}::uuid)`);
  assert(acknowledged[0] && again[0] && new Date(acknowledged[0].at).getTime() === new Date(again[0].at).getTime(), "acknowledgement is idempotent");
  const unknown = await withStaffUser(api, staffId, (tx) => tx`select * from staff_acknowledge_runtime_link_alert(${crypto.randomUUID()}::uuid)`);
  assert(unknown.length === 0, "an unknown alert acknowledges nothing");

  await target`update runtimes set last_health_status = 'healthy', last_health_error = null where id = ${downRuntime}`;
  await target`update runtimes set revoked_at = now() where id = ${staleRuntime}`;
  const back = await evaluateRuntimeLinkAlerts(worker, options);
  assert(back.resolved === 2 && back.opened === 0, `a reconnected and a revoked runtime resolve their alerts, got ${JSON.stringify(back)}`);
  // Only the reconnected runtime, whose alert had emailed three people, says it is back.
  assert(back.restoredEmails === 3, `the three people told of the outage hear it is back, got ${back.restoredEmails}`);
  const restored = await target<Array<{ recipient: string; dedupeKey: string; restoredAt: string | null; runtimeName: string }>>`
    select recipient_email as recipient, dedupe_key as "dedupeKey",
           payload->>'restoredAt' as "restoredAt", payload->>'runtimeName' as "runtimeName"
      from email_outbox where kind = 'runtime_link_restored' order by recipient_email
  `;
  assert(restored.length === 3 && restored.every((email) => email.runtimeName === "VPS down" && email.restoredAt), `restored emails name the runtime and the time, got ${JSON.stringify(restored)}`);
  assert(restored.every((email) => email.dedupeKey.startsWith("runtime_link_restored:")), "restored dedupe keys are scoped to the alert");
  const replayBack = await evaluateRuntimeLinkAlerts(worker, options);
  assert(replayBack.restoredEmails === 0 && replayBack.resolved === 0, `a replayed pass sends nothing more, got ${JSON.stringify(replayBack)}`);
  const open = await target<Array<{ count: string }>>`select count(*)::text as count from runtime_link_alerts where status = 'open'`;
  assert(open[0]?.count === "0", "no alert stays open");

  console.log("OHB-87 PostgreSQL proof passed: 0087 alerts open after the threshold, email the pairer and admins once, skip stale outages, resolve on reconnect or revocation, say when the link is back, wait after a worker start, stay tenant-scoped and serve staff.");
} finally {
  await api?.close();
  await worker?.close();
  await target?.close();
  if (databaseCreated) {
    await adminDb`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${database} and pid <> pg_backend_pid()`;
    await adminDb.unsafe(`drop database "${database}"`);
  }
  await adminDb.close();
}
