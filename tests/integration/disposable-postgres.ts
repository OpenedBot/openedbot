import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [output, , status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`PostgreSQL discovery failed (${command[0]})`);
  return output.trimEnd();
}

/** The owner URL of the shared PostgreSQL: the explicit setting, else the dev-infra container. */
export async function adminUrl(): Promise<URL> {
  if (process.env.INTEGRATION_ADMIN_DATABASE_URL) return new URL(process.env.INTEGRATION_ADMIN_DATABASE_URL);
  const container = process.env.OPENEDBOT_POSTGRES_CONTAINER ?? "infra-postgres";
  const port = (await capture(["docker", "port", container, "5432/tcp"])).split("\n")
    .find((line) => line.startsWith("127.0.0.1:") || line.startsWith("0.0.0.0:"))?.split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("Existing PostgreSQL must expose a loopback port.");
  const credentials = await capture(["docker", "exec", container, "sh", "-ceu", 'printf "%s\\n%s" "$POSTGRES_USER" "$POSTGRES_PASSWORD"']);
  const newline = credentials.indexOf("\n");
  if (newline < 1) throw new Error("PostgreSQL credentials are unavailable.");
  const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
  url.username = credentials.slice(0, newline);
  url.password = credentials.slice(newline + 1);
  return url;
}

export type DisposablePostgres = {
  owner: SQL;
  /** Private in-memory URL, never log it or put it in process arguments. */
  url: string;
  connect(role?: "openedbot_api" | "openedbot_worker" | "openedbot_staff"): Promise<SQL>;
  /** Applies the migrations held back by `stopBefore`, in order; once it succeeds, again it does nothing. */
  migrateRest(): Promise<void>;
};

export type DisposablePostgresOptions = {
  /** Migrate only the files sorting before this one (e.g. `0180_`), to seed data a later migration must transform. */
  stopBefore?: string;
};

/** Owns only its unique created database and connections. Never resets shared data or roles. */
export async function withDisposablePostgres<T>(
  label: string,
  callback: (database: DisposablePostgres) => Promise<T>,
  options: DisposablePostgresOptions = {},
): Promise<T> {
  if (!/^openedbot[0-9]+_[a-z0-9_]+$/.test(label)) throw new Error("Invalid disposable database label.");
  const source = await adminUrl();
  const admin = new SQL({ url: source.toString(), max: 1 });
  const database = `${label}_${crypto.randomUUID().replaceAll("-", "")}`;
  const destination = new URL(source); destination.pathname = `/${database}`;
  const clients: SQL[] = [];
  let created = false;
  try {
    const roles = await admin<Array<{ name: string }>>`select rolname as name from pg_roles where rolname in ('openedbot_api', 'openedbot_worker', 'openedbot_staff')`;
    if (roles.length !== 3) throw new Error("The existing openedbot database roles are required.");
    await admin.unsafe(`create database "${database}"`);
    created = true;
    const owner = new SQL({ url: destination.toString(), max: 1 }); clients.push(owner);
    const migrations = resolve(import.meta.dir, "../../db/migrations");
    const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort();
    const { stopBefore } = options;
    if (stopBefore !== undefined && !files.some((file) => file.startsWith(stopBefore))) {
      throw new Error(`No migration starts with ${stopBefore}.`);
    }
    const held = stopBefore === undefined ? [] : files.filter((file) => file >= stopBefore);
    const apply = async (batch: string[]) => {
      for (const file of batch) await owner.unsafe(await Bun.file(resolve(migrations, file)).text());
    };
    await apply(files.filter((file) => !held.includes(file)));
    let rest: Promise<void> | null = null;
    return await callback({
      owner,
      url: destination.toString(),
      connect: async (role) => {
        const connection = new SQL({ url: destination.toString(), max: 1 }); clients.push(connection);
        if (role) await connection.unsafe(`set role ${role}`);
        return connection;
      },
      // A migration that raises leaves its explicit transaction aborted on the
      // owner connection: roll it back, and let a later call try again.
      migrateRest: () => (rest ??= apply(held).catch(async (error: unknown) => {
        rest = null;
        await owner.unsafe("rollback");
        throw error;
      })),
    });
  } finally {
    await Promise.allSettled(clients.map((connection) => connection.close()));
    try { if (created) await admin.unsafe(`drop database "${database}"`); }
    finally { await admin.close(); }
  }
}
