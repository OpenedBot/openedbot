/**
 * Prove 0157 against a disposable PostgreSQL database (DEV-OPE2-7): Discord
 * alert channels are encrypted and tenant-scoped, a link alert queues one
 * delivery per enabled channel, the worker sends 🔴 then 🟢, retries a Discord
 * outage, disables a deleted webhook and drops a 🔴 the outage outlived.
 */
import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { secretEncryptionKey } from "../../platform/hermes/src/secrets";
import { withTenant } from "../../platform/db/src/db";
import { evaluateRuntimeLinkAlerts } from "../../modules/runtime-link/src/application/link-alerts";
import {
  createDiscordAlertChannel,
  deleteOrganizationAlertChannel,
  listOrganizationAlertChannels,
  testOrganizationAlertChannel,
  updateOrganizationAlertChannel,
} from "../../modules/notifications/src/application/alert-channels";
import { processAlertDeliveries } from "../../modules/notifications/src/application/alert-deliveries";
import type { DiscordTransport } from "../../modules/notifications/src/application/discord-transport";
import type { DiscordMessage } from "../../modules/notifications/src/domain/alert-channels";

const root = resolve(import.meta.dir, "../..");
const organizationA = "57000000-0000-4000-8000-000000000001";
const organizationB = "57000000-0000-4000-8000-000000000002";
const owner = "57000000-0000-4000-8000-000000000011";
const runtimeOne = "57000000-0000-4000-8000-000000000021";
const runtimeTwo = "57000000-0000-4000-8000-000000000022";
const runtimeThree = "57000000-0000-4000-8000-000000000023";
const keyring = { current: secretEncryptionKey(new Uint8Array(32).fill(5)), previous: [] };
const options = { downAfterMinutes: 5, webAppUrl: "https://console.ohb.test/", environment: "dev" };
const webhook = (n: number) => `https://discord.com/api/webhooks/14596853750385911${n}0/${"k".repeat(60)}${n}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A Discord that answers what the test scripts, and records what it was sent. */
function scriptedDiscord() {
  const posts: Array<{ url: string; message: DiscordMessage }> = [];
  let next: Array<number | "network"> = [];
  const transport: DiscordTransport = {
    inspect: async () => ({ status: 200, name: "Alertes ops" }),
    post: async (url, message) => {
      const answer = next.shift() ?? 204;
      if (answer === "network") {
        const { DiscordTransportError } = await import("../../modules/notifications/src/application/discord-transport");
        throw new DiscordTransportError("network");
      }
      posts.push({ url, message });
      return { status: answer, retryAfterSeconds: null };
    },
  };
  return { transport, posts, answer: (...answers: Array<number | "network">) => { next = answers; } };
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
const database = `ohb157_alerts_${crypto.randomUUID().replaceAll("-", "")}`;
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
      (${organizationA}, 'ohb157-a', 'OHB-157 A'),
      (${organizationB}, 'ohb157-b', 'OHB-157 B')`;
  await target`insert into users (id, email, display_name) values (${owner}, 'ohb157-owner@example.test', 'Owner')`;
  await target`insert into memberships (organization_id, user_id, role) values (${organizationA}, ${owner}, 'owner')`;
  await target`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, last_health_status, last_health_error, link_last_seen_at)
    values
      (${runtimeOne}, ${organizationA}, 'VPS @everyone', 'connector', 'ohb157-hash-1', false, 'disconnected', 'Aucun signe de vie du lien depuis 45 s.', now() - interval '10 minutes'),
      (${runtimeTwo}, ${organizationA}, 'VPS deux', 'connector', 'ohb157-hash-2', false, 'healthy', null, now()),
      (${runtimeThree}, ${organizationA}, 'VPS trois', 'connector', 'ohb157-hash-3', false, 'healthy', null, now())`;

  worker = new SQL({ url: databaseUrl(source, database, "ohb_worker", "ohb_worker_dev"), max: 1 });
  api = new SQL({ url: databaseUrl(source, database, "ohb_api", "ohb_api_dev"), max: 1 });
  const discord = scriptedDiscord();
  const scope = { organizationId: organizationA, userId: owner };
  const deps = { keyring, transport: discord.transport };
  const workerConfig = { tokenEncryption: keyring, workerId: "ohb157-worker" };

  // Channels: encrypted at rest, duplicates and foreign URLs refused, tenant-scoped.
  const created = await createDiscordAlertChannel(api, scope, { webhookUrl: webhook(1), label: undefined }, deps);
  assert(created.kind === "created" && created.channel.label === "Alertes ops", `the channel takes the webhook name, got ${JSON.stringify(created)}`);
  const channelId = created.channel.id;
  assert(!JSON.stringify(created).includes("k".repeat(60)), "the created channel never echoes the webhook token");
  const spare = await createDiscordAlertChannel(api, scope, { webhookUrl: webhook(2), label: "Spare" }, deps);
  assert(spare.kind === "created", "a second webhook is a second channel");
  await updateOrganizationAlertChannel(api, organizationA, spare.channel.id, { enabled: false });
  const duplicate = await createDiscordAlertChannel(api, scope, { webhookUrl: webhook(1).replace("discord.com", "discordapp.com"), label: "Again" }, deps);
  assert(duplicate.kind === "duplicate", `the same webhook under another host is a duplicate, got ${duplicate.kind}`);
  const foreign = await createDiscordAlertChannel(api, scope, { webhookUrl: "https://127.0.0.1/api/webhooks/1/2", label: "x" }, deps);
  assert(foreign.kind === "invalid_url", "a non-Discord URL is refused before any call");

  const stored = await target<Array<{ ciphertext: string }>>`select secret_ciphertext as ciphertext from alert_channels where id = ${channelId}`;
  assert(stored[0] && !stored[0].ciphertext.includes("kkkk"), "the webhook URL is stored encrypted");
  assert((await listOrganizationAlertChannels(api, organizationB)).length === 0, "RLS: another organization sees no channel");
  const workerBlind = await worker<Array<{ count: number }>>`select count(*)::int as count from alert_channels`;
  assert(workerBlind[0]?.count === 0, "RLS: the worker reads channels only under a tenant");

  // A link alert queues one delivery per ENABLED channel, once.
  const first = await evaluateRuntimeLinkAlerts(worker, options);
  assert(first.opened === 1 && first.channelDeliveries === 1, `one alert, one delivery (the spare is off), got ${JSON.stringify(first)}`);
  const replay = await evaluateRuntimeLinkAlerts(worker, options);
  assert(replay.channelDeliveries === 0, "a replayed pass queues nothing");

  // Discord down: the delivery backs off, then goes out.
  discord.answer(503);
  const outage = await processAlertDeliveries(worker, workerConfig, discord.transport);
  assert(outage.retried === 1 && outage.sent === 0, `a 503 is retried later, got ${JSON.stringify(outage)}`);
  const waiting = await processAlertDeliveries(worker, workerConfig, discord.transport);
  assert(waiting.retried === 0 && waiting.sent === 0, "a backed-off delivery is not due yet");
  await target`update alert_deliveries set available_at = now()`;
  const sent = await processAlertDeliveries(worker, workerConfig, discord.transport);
  assert(sent.sent === 1, `the delivery goes out once Discord is back, got ${JSON.stringify(sent)}`);
  const down = discord.posts.at(-1)!;
  assert(down.url === webhook(1), "the decrypted webhook is the one called");
  assert(down.message.content.startsWith("🔴") && down.message.content.includes("VPS @everyone") && down.message.content.includes("[dev]"), `down message: ${down.message.content}`);
  assert(JSON.stringify(down.message.allowed_mentions) === JSON.stringify({ parse: [] }), "no mention can ping");
  const afterSend = await listOrganizationAlertChannels(api, organizationA);
  assert(afterSend.find((channel) => channel.id === channelId)?.lastDeliveredAt, "the channel records its last delivery");

  // Back online: a 🟢 to the channel that had the 🔴.
  await target`update runtimes set last_health_status = 'healthy', last_health_error = null, link_last_seen_at = now() where id = ${runtimeOne}`;
  const back = await evaluateRuntimeLinkAlerts(worker, options);
  assert(back.resolved === 1 && back.channelDeliveries === 1, `the restored alert queues one 🟢, got ${JSON.stringify(back)}`);
  const restored = await processAlertDeliveries(worker, workerConfig, discord.transport);
  assert(restored.sent === 1 && discord.posts.at(-1)!.message.content.startsWith("🟢"), "the 🟢 goes out");

  // An outage shorter than a Discord outage: the late 🔴 is dropped, no 🟢 follows.
  await target`update runtimes set last_health_status = 'disconnected', link_last_seen_at = now() - interval '10 minutes' where id = ${runtimeTwo}`;
  assert((await evaluateRuntimeLinkAlerts(worker, options)).channelDeliveries === 1, "the second outage queues its 🔴");
  await target`update runtimes set last_health_status = 'healthy', link_last_seen_at = now() where id = ${runtimeTwo}`;
  const short = await evaluateRuntimeLinkAlerts(worker, options);
  assert(short.resolved === 1 && short.channelDeliveries === 0, `a 🔴 never sent calls for no 🟢, got ${JSON.stringify(short)}`);
  const cancelled = await target<Array<{ status: string }>>`
    select d.status from alert_deliveries d join runtime_link_alerts a on a.id = d.alert_id where a.runtime_id = ${runtimeTwo}`;
  assert(cancelled.length === 1 && cancelled[0]!.status === "cancelled", `the late 🔴 is cancelled, got ${JSON.stringify(cancelled)}`);
  const posts = discord.posts.length;
  await processAlertDeliveries(worker, workerConfig, discord.transport);
  assert(discord.posts.length === posts, "nothing is sent for the short outage");

  // The webhook was deleted on Discord: the channel turns off and says why.
  await target`update runtimes set last_health_status = 'disconnected', link_last_seen_at = now() - interval '10 minutes' where id = ${runtimeThree}`;
  await evaluateRuntimeLinkAlerts(worker, options);
  discord.answer(404);
  const revoked = await processAlertDeliveries(worker, workerConfig, discord.transport);
  assert(revoked.failed === 1, `a 404 fails the delivery, got ${JSON.stringify(revoked)}`);
  const off = (await listOrganizationAlertChannels(api, organizationA)).find((channel) => channel.id === channelId);
  assert(off && !off.enabled && off.lastFailureReason === "webhook_revoked" && off.lastFailureStatus === 404, `the channel is disabled as revoked, got ${JSON.stringify(off)}`);
  const reenabled = await updateOrganizationAlertChannel(api, organizationA, channelId, { enabled: true });
  assert(reenabled.kind === "updated" && reenabled.channel.enabled && reenabled.channel.lastFailureReason === null, "re-enabling clears the failure");

  // The test button: sent now, then throttled.
  const tested = await testOrganizationAlertChannel(api, organizationA, channelId, { ...deps, environment: "dev" });
  assert(tested.kind === "delivered" && discord.posts.at(-1)!.message.content.startsWith("✅"), `the test message is delivered, got ${tested.kind}`);
  const throttled = await testOrganizationAlertChannel(api, organizationA, channelId, { ...deps, environment: "dev" });
  assert(throttled.kind === "cooldown", "a second test right away is throttled");
  const elsewhere = await testOrganizationAlertChannel(api, organizationB, channelId, { ...deps, environment: "dev" });
  assert(elsewhere.kind === "not_found", "RLS: another organization cannot test the channel");

  // Removing a channel removes its deliveries.
  assert(await deleteOrganizationAlertChannel(api, organizationA, channelId), "the channel is removed");
  const left = await target<Array<{ count: number }>>`select count(*)::int as count from alert_deliveries where channel_id = ${channelId}`;
  assert(left[0]?.count === 0, "its deliveries cascade");
  assert(!(await deleteOrganizationAlertChannel(api, organizationB, spare.channel.id)), "RLS: another organization cannot remove a channel");
  const apiQueue = await withTenant(api, organizationA, (tx) => tx`select 1 from alert_deliveries`.then(() => "read", (error) => String(error)));
  assert(apiQueue !== "read", "the API has no access to the delivery queue");

  console.log("OHB-157 PostgreSQL proof passed: alert channels are encrypted and tenant-scoped, a link alert queues one delivery per enabled channel once, Discord outages back off, deleted webhooks disable their channel, a 🔴 the outage outlived is dropped, 🟢 follows 🔴, tests are throttled and deletions cascade.");
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
