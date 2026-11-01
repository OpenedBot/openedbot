/** Provision only a new disposable database; never starts a service or a build. */
import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

async function capture(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (status !== 0) throw new Error(`Test database discovery failed (${command[0]}): ${error}`);
  return output.trimEnd();
}

async function adminUrl(): Promise<URL> {
  if (process.env.INTEGRATION_ADMIN_DATABASE_URL) return new URL(process.env.INTEGRATION_ADMIN_DATABASE_URL);
  const container = process.env.OPENEDBOT_POSTGRES_CONTAINER ?? "infra-postgres";
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

const root = resolve(import.meta.dir, "../..");
const source = await adminUrl();
const database = `ohb56_import_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new SQL({ url: source.toString(), max: 1 });
let created = false;
let target: SQL | null = null;
try {
  // Role definitions match the existing PostgreSQL integration harness. Existing
  // roles are never altered; the fixture uses SET ROLE, not their passwords.
  await admin.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = 'ohb_api') then create role ohb_api login password 'ohb_api_dev' nosuperuser nocreatedb nocreaterole; end if;
    if not exists (select from pg_roles where rolname = 'ohb_worker') then create role ohb_worker login password 'ohb_worker_dev' nosuperuser nocreatedb nocreaterole; end if;
    if not exists (select from pg_roles where rolname = 'ohb_staff') then create role ohb_staff login password 'ohb_staff_dev' nosuperuser nocreatedb nocreaterole; end if;
  end $$`);
  await admin.unsafe(`create database "${database}"`);
  created = true;
  const destination = new URL(source); destination.pathname = `/${database}`;
  target = new SQL({ url: destination.toString(), max: 1 });
  for (const migration of (await readdir(resolve(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await target.unsafe(await Bun.file(resolve(root, "db/migrations", migration)).text());
  }
  await target.close(); target = null;
  const fixture = Bun.spawn(["bun", "tests/integration/profile-imports.ts"], {
    cwd: root, env: { ...process.env, INTEGRATION_ADMIN_DATABASE_URL: destination.toString() },
    stdout: "inherit", stderr: "inherit",
  });
  if (await fixture.exited !== 0) throw new Error("Profile import integration proof failed.");
} finally {
  await target?.close();
  if (created) {
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${database} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database "${database}"`);
  }
  await admin.close();
}
