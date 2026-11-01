/**
 * 0082 on the real worker functions: provision a disposable database, never a
 * service or a build. The worker connects as `ohb_worker`, and each converted
 * access must see its own organization's rows only because it sets
 * `app.organization_id` itself: without it, PostgreSQL returns no row and no
 * error, which is exactly the silent regression this proof exists to catch.
 */
import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { persistThreadCompaction, readThreadCompaction } from "../../modules/conversation/src/application/compact-thread";
import { clearProviderIncident, loadActiveIncidents, recordProviderIncident } from "../../modules/execution/src/application/provider-fallback";
import { loadAssignedPlaybooks } from "../../modules/execution/src/application/runner";

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`Test database discovery failed (${command[0]}): ${error}`);
  return output.trimEnd();
}

async function adminUrl(): Promise<URL> {
  if (process.env.INTEGRATION_ADMIN_DATABASE_URL) return new URL(process.env.INTEGRATION_ADMIN_DATABASE_URL);
  const container = process.env.OHB_POSTGRES_CONTAINER ?? "infra-postgres";
  const port = (await capture(["docker", "port", container, "5432/tcp"])).split("\n").find((line) => line.startsWith("127.0.0.1:") || line.startsWith("0.0.0.0:"))?.split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("Existing PostgreSQL must expose a loopback port, or supply INTEGRATION_ADMIN_DATABASE_URL.");
  // Credentials are captured in memory only, never printed or passed in argv.
  const credentials = await capture(["docker", "exec", container, "sh", "-ceu", 'printf "%s\\n%s" "$POSTGRES_USER" "$POSTGRES_PASSWORD"']);
  const newline = credentials.indexOf("\n");
  if (newline < 1) throw new Error("Existing PostgreSQL credentials are unavailable.");
  const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
  url.username = credentials.slice(0, newline);
  url.password = credentials.slice(newline + 1);
  return url;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const ORG_A = "82000000-0000-4000-8000-00000000000a";
const ORG_B = "82000000-0000-4000-8000-00000000000b";
const ids = (org: string) => {
  const tail = org.slice(-1);
  return {
    section: `82000000-0000-4000-8000-0000000001${tail}0`,
    bot: `82000000-0000-4000-8000-0000000002${tail}0`,
    thread: `82000000-0000-4000-8000-0000000003${tail}0`,
    runtime: `82000000-0000-4000-8000-0000000004${tail}0`,
    playbook: `82000000-0000-4000-8000-0000000005${tail}0`,
  };
};

const root = resolve(import.meta.dir, "../..");
const source = await adminUrl();
const database = `ohb82_scope_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new SQL({ url: source.toString(), max: 1 });
let created = false;
let target: SQL | null = null;
let worker: SQL | null = null;
try {
  await admin.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = 'ohb_api') then create role ohb_api login password 'ohb_api_dev' nosuperuser nocreatedb nocreaterole; end if;
    if not exists (select from pg_roles where rolname = 'ohb_worker') then create role ohb_worker login password 'ohb_worker_dev' nosuperuser nocreatedb nocreaterole; end if;
    if not exists (select from pg_roles where rolname = 'ohb_staff') then create role ohb_staff login password 'ohb_staff_dev' nosuperuser nocreatedb nocreaterole; end if;
  end $$`);
  await admin.unsafe(`create database "${database}"`);
  created = true;
  const destination = new URL(source);
  destination.pathname = `/${database}`;
  target = new SQL({ url: destination.toString(), max: 1 });
  for (const migration of (await readdir(resolve(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await target.unsafe(await Bun.file(resolve(root, "db/migrations", migration)).text());
  }

  for (const [org, slug] of [[ORG_A, "scope-a"], [ORG_B, "scope-b"]] as const) {
    const row = ids(org);
    await target`insert into organizations (id, slug, name) values (${org}, ${slug}, ${slug})`;
    await target`insert into sections (id, organization_id, name, position) values (${row.section}, ${org}, 'Scope', 0)`;
    await target`insert into bots (id, organization_id, section_id, name, slug, hermes_profile, position)
      values (${row.bot}, ${org}, ${row.section}, 'Scope bot', ${`${slug}-bot`}, ${`${slug}-profile`}, 0)`;
    await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${row.thread}, ${org}, ${row.bot}, 'Scope thread', ${`${slug}-session`}, true)`;
    await target`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active)
      values (${row.runtime}, ${org}, 'Scope runtime', 'connector', ${`${slug}-link-hash`}, true)`;
    await target`insert into playbooks (id, organization_id, key, name) values (${row.playbook}, ${org}, ${`${slug}-playbook`}, 'Scope playbook')`;
    await target`insert into bot_playbooks (organization_id, bot_id, playbook_id) values (${org}, ${row.bot}, ${row.playbook})`;
  }
  await target.close();
  target = null;

  worker = new SQL({ url: destination.toString(), max: 2, connection: { options: "-c role=ohb_worker" } });
  const a = ids(ORG_A);
  const unscopedCount = async (table: string) =>
    Number((await worker!.unsafe(`select count(*)::int as n from ${table}`))[0].n);

  // runtime_provider_incidents: provider-fallback.ts
  await recordProviderIncident(worker, {
    organizationId: ORG_A, runtimeId: a.runtime, provider: "openai-codex", kind: "quota", runId: crypto.randomUUID(),
    message: null, fallbackProvider: null, fallbackModel: null,
  });
  assertEqual((await loadActiveIncidents(worker, ORG_A, a.runtime)).map((row) => row.provider), ["openai-codex"], "incident read under tenant A");
  assertEqual(await unscopedCount("runtime_provider_incidents"), 0, "incidents without app.organization_id");
  await clearProviderIncident(worker, ORG_A, a.runtime, "openai-codex");
  assertEqual((await loadActiveIncidents(worker, ORG_A, a.runtime)).length, 0, "incident cleared under tenant A");

  // thread_compactions: compact-thread.ts
  await persistThreadCompaction(worker, ORG_A, a.thread, { summary: "scope", compactedThroughSequence: 3, sourceMessageCount: 2 });
  assertEqual((await readThreadCompaction(worker, ORG_A, a.thread))?.summary, "scope", "compaction read under tenant A");
  assertEqual(await readThreadCompaction(worker, ORG_B, a.thread), null, "compaction of A under tenant B");
  assertEqual(await unscopedCount("thread_compactions"), 0, "compactions without app.organization_id");

  // playbooks, bot_playbooks: runner.ts
  assertEqual((await loadAssignedPlaybooks(worker, ORG_A, a.bot)).map((row) => row.key), ["scope-a-playbook"], "playbooks under tenant A");
  assertEqual(await loadAssignedPlaybooks(worker, ORG_B, a.bot), [], "playbooks of A under tenant B");
  assertEqual(await unscopedCount("playbooks"), 0, "playbooks without app.organization_id");
  assertEqual(await unscopedCount("bot_playbooks"), 0, "bot_playbooks without app.organization_id");

  // message_reactions, support_messages: no privilege at all.
  for (const table of ["message_reactions", "support_messages"]) {
    let code = "none";
    try {
      await unscopedCount(table);
    } catch (error) {
      code = String((error as { errno?: string; code?: string }).errno ?? (error as { code?: string }).code);
    }
    assertEqual(code, "42501", `${table} privilege`);
  }

  console.log("Worker tenant scope proof passed: incidents, compactions and playbooks read under the run's tenant only, reactions and support messages refused.");
} finally {
  await worker?.close();
  await target?.close();
  if (created) {
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${database} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database "${database}"`);
  }
  await admin.close();
}
