/** A local restore proof: unique database and directories, never an existing target. */
import { SQL } from "bun";
import { strict as assert } from "node:assert";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMvpFixture } from "./mvp-workflows";

await withMvpFixture(async ({ database, organizationId, userId, threadId }) => {
  const source = new URL(database.url).pathname.slice(1);
  const restored = `openedbot189_restore_${crypto.randomUUID().replaceAll("-", "")}`;
  const directory = await mkdtemp(join(tmpdir(), "openedbot-mvp-recovery-"));
  const attachmentId = crypto.randomUUID(),
    messageId = crypto.randomUUID();
  const content = "Témoin de restauration — fichier français.\n";
  const key = `org/${organizationId}/${attachmentId}`;
  const adminUrl = new URL(database.url);
  adminUrl.pathname = "/postgres";
  const admin = new SQL({ url: adminUrl.toString(), max: 1 });
  let created = false;
  let restoredDb: SQL | undefined;
  const capture = async (
    command: string[],
    stdin?: Uint8Array,
    env?: Record<string, string>,
  ) => {
    const child = Bun.spawn(command, {
      stdin: stdin ? new Blob([new Uint8Array(stdin)]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const [output, error, status] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0)
      throw new Error(
        `Recovery command ${command[0]} failed (${status}): ${error.slice(0, 300)}`,
      );
    return new Uint8Array(output);
  };
  try {
    await database.owner`insert into messages(id,organization_id,thread_id,role,content) values(${messageId},${organizationId},${threadId},'assistant','[{"type":"text","text":"Mémoire témoin"}]'::jsonb)`;
    await database.owner`insert into attachments(id,organization_id,message_id,object_key,driver,name,content_type,kind,bytes)
      values(${attachmentId},${organizationId},${messageId},${key},'file','témoin.txt','text/plain','document',${new TextEncoder().encode(content).length})`;
    await Bun.write(join(directory, "source", key), content);
    const tools = await postgresTools(database.url, admin, capture);
    const dump = await tools.dump(source);
    await admin.unsafe(`create database "${restored}"`);
    created = true;
    await tools.restore(restored, dump);
    await cp(join(directory, "source"), join(directory, "restored"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const restoreUrl = new URL(database.url);
    restoreUrl.pathname = `/${restored}`;
    restoredDb = new SQL({ url: restoreUrl.toString(), max: 1 });
    const rows =
      await restoredDb`select content from messages where organization_id=${organizationId} and id=${messageId}`;
    assert.equal(rows[0]!.content[0].text, "Mémoire témoin");
    assert.equal(
      (
        await restoredDb`select object_key from attachments where id=${attachmentId}`
      )[0]!.object_key,
      key,
    );
    const hash = async (path: string) =>
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(path).arrayBuffer())
        .digest("hex");
    assert.equal(
      await hash(join(directory, "source", key)),
      await hash(join(directory, "restored", key)),
    );
    assert.equal(
      (
        await database.owner`select count(*)::int as n from schema_migrations`
      )[0]!.n,
      (await restoredDb`select count(*)::int as n from schema_migrations`)[0]!
        .n,
    );
    assert.equal(
      (
        await restoredDb`select count(*)::int as n from memberships where user_id=${userId}`
      )[0]!.n,
      1,
    );
    console.info(
      "MVP recovery PASS: PostgreSQL dump restored into a new database, migrations, message, membership, attachment metadata and file SHA-256 match. Hermes/R2/key recovery not exercised.",
    );
  } finally {
    await restoredDb?.close();
    if (created) await admin.unsafe(`drop database "${restored}"`);
    await admin.close();
    await rm(directory, { recursive: true, force: true });
  }
});

type Capture = (
  command: string[],
  stdin?: Uint8Array,
  env?: Record<string, string>,
) => Promise<Uint8Array>;

/**
 * pg_dump and pg_restore of the server's own major version, never skipped.
 * With INTEGRATION_ADMIN_DATABASE_URL (CI, the same switch as `adminUrl`),
 * the client tools of INTEGRATION_PG_BIN (else PATH) reach the server by its
 * URL, and their major must be the server's: a pg_dump 16 refuses a server
 * 17, and its error would hide the proof behind a version message. Without
 * it (local dev), the tools inside the dev-infra container.
 */
async function postgresTools(url: string, admin: SQL, capture: Capture) {
  if (!process.env.INTEGRATION_ADMIN_DATABASE_URL) {
    const container =
      process.env.OPENEDBOT_POSTGRES_CONTAINER ?? "infra-postgres";
    const inContainer = (tool: string, flags: string) =>
      `exec ${tool} -U "$POSTGRES_USER" ${flags} "$1"`;
    return {
      dump: (name: string) =>
        capture(["docker", "exec", container, "sh", "-ceu", inContainer("pg_dump", "-Fc"), "recovery", name]),
      restore: async (name: string, dump: Uint8Array) => {
        await capture(
          ["docker", "exec", "-i", container, "sh", "-ceu", inContainer("pg_restore", "--exit-on-error --no-owner -d"), "recovery", name],
          dump,
        );
      },
    };
  }
  const bin = process.env.INTEGRATION_PG_BIN;
  const tool = (name: string) => (bin ? join(bin, name) : name);
  const major = (await admin<Array<{ major: number }>>`select current_setting('server_version_num')::int / 10000 as major`)[0]!.major;
  for (const name of ["pg_dump", "pg_restore"]) {
    const version = new TextDecoder().decode(await capture([tool(name), "--version"]));
    const clientMajor = Number(/\(PostgreSQL\) (\d+)/.exec(version)?.[1]);
    if (clientMajor !== major)
      throw new Error(
        `Recovery needs ${name} ${major} for a PostgreSQL ${major} server, found: ${version.trim() || "no version"}. Point INTEGRATION_PG_BIN at the ${major} client tools.`,
      );
  }
  // The connection goes through libpq's environment: no password in argv.
  const target = new URL(url);
  const env: Record<string, string> = {
    PGHOST: target.hostname,
    PGPORT: target.port || "5432",
    PGUSER: decodeURIComponent(target.username),
  };
  if (target.password) env.PGPASSWORD = decodeURIComponent(target.password);
  const sslmode = target.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return {
    dump: (name: string) => capture([tool("pg_dump"), "-Fc", "-d", name], undefined, env),
    restore: async (name: string, dump: Uint8Array) => {
      await capture([tool("pg_restore"), "--exit-on-error", "--no-owner", "-d", name], dump, env);
    },
  };
}
