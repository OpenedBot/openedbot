/** Prove direct runtime access against a disposable PostgreSQL database and the real routes. */
import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { decryptSecretFromKeyring, encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/index.ts";
import { runtimeRoutes } from "../../apps/api/src/routes/runtimes/runtime-routes";
import { runtimeExposureRoutes } from "../../apps/api/src/routes/runtimes/runtime-exposure-routes";
import { withTenant } from "../../platform/db/src/db";
import { NO_RUNTIME_LINKS } from "../../modules/runtime-link/src/application/dialer";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";

const root = resolve(import.meta.dir, "../..");
const organizationA = "81000000-0000-4000-8000-000000000001";
const organizationB = "82000000-0000-4000-8000-000000000002";
const runtimeA = "81000000-0000-4000-8000-000000000011";
const runtimeB = "82000000-0000-4000-8000-000000000012";
const key = secretEncryptionKey(new Uint8Array(32).fill(7));

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
const database = `openedbot74_access_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new SQL({ url: source.toString(), max: 1 });
let target: SQL | null = null;
let api: SQL | null = null;
let databaseCreated = false;
let fake: ReturnType<typeof Bun.serve> | null = null;
const requests: Array<{ path: string; authorization: string | null; clientId: string | null; clientSecret: string | null }> = [];

try {
  await admin.unsafe(`do $$ begin
    if not exists (select from pg_roles where rolname = 'openedbot_api') then create role openedbot_api login password 'openedbot_api_dev' nosuperuser nocreatedb nocreaterole; end if;
    if not exists (select from pg_roles where rolname = 'openedbot_worker') then create role openedbot_worker login password 'openedbot_worker_dev' nosuperuser nocreatedb nocreaterole; end if;
  end $$`);
  await admin.unsafe(`create database "${database}"`);
  databaseCreated = true;
  await admin.unsafe(`grant connect on database "${database}" to openedbot_api, openedbot_worker`);

  const destination = databaseUrl(source, database, source.username, source.password);
  target = new SQL({ url: destination, max: 1 });
  for (const migration of (await readdir(resolve(root, "db/migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    await target.unsafe(await Bun.file(resolve(root, "db/migrations", migration)).text());
  }

  fake = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        clientId: request.headers.get("cf-access-client-id"),
        clientSecret: request.headers.get("cf-access-client-secret"),
      });
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ status: "ok" });
      if (path === "/v1/capabilities") return Response.json({ max_concurrent_runs: 2 });
      if (path === "/v1/toolsets") return Response.json({ data: [] });
      return new Response("not found", { status: 404 });
    },
  });
  const endpoint = fake.url.toString().replace(/\/$/, "");

  const bearer = encryptSecret("seed-bearer", key.value);
  await target`insert into organizations (id, slug, name) values
      (${organizationA}, 'openedbot74-a', 'Direct access A'),
      (${organizationB}, 'openedbot74-b', 'Direct access B')`;
  // A publication records who created it (FK to users).
  await target`insert into users (id, email) values ('81000000-0000-4000-8000-000000000021', 'openedbot74-owner@example.test')`;
  await target`insert into memberships (organization_id, user_id, role) values (${organizationA}, '81000000-0000-4000-8000-000000000021', 'owner')`;
  await target`insert into runtimes (
      id, organization_id, name, reachability, endpoint,
      token_ciphertext, token_nonce, token_tag, token_key_id, is_active
    ) values
      (${runtimeA}, ${organizationA}, 'Direct A', 'direct', ${endpoint},
       ${bearer.ciphertext}, ${bearer.nonce}, ${bearer.tag}, ${key.id}, false),
      (${runtimeB}, ${organizationB}, 'Direct B', 'direct', ${endpoint},
       ${bearer.ciphertext}, ${bearer.nonce}, ${bearer.tag}, ${key.id}, false)`;
  await target.close();
  target = null;

  api = new SQL({ url: databaseUrl(source, database, "openedbot_api", "openedbot_api_dev"), max: 2 });
  const config = {
    environment: "test",
    // La réponse de PUT /access porte la commande de reliaison du connecteur.
    publicUrl: "https://openedbot74.example.test",
    tokenEncryption: { current: key, previous: [] },
    hermesEndpointPolicy: { environment: "test", testHttpUrl: endpoint },
    hermesMtls: null,
    billingEnforced: false,
    connectorVersions: {},
  } as unknown as ApiConfig;
  const auth: AuthContext = {
    sessionId: "openedbot74-session",
    organizationId: organizationA,
    userId: "81000000-0000-4000-8000-000000000021",
    role: "owner",
    kind: "web",
    credentialHash: "openedbot74-credential",
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  app.route("/", runtimeRoutes(api, config, NO_RUNTIME_LINKS));

  const update = await app.request(`/${runtimeA}/access`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: endpoint,
      token: "new-bearer",
      edgeAuth: { clientId: "access-client-id", clientSecret: "access-client-secret" },
    }),
  });
  assert(update.status === 200, `PUT /access returned ${update.status}`);
  const updateDto = await update.json() as { edgeAuthConfigured?: boolean };
  assert(updateDto.edgeAuthConfigured === true, "PUT /access did not expose the configured flag");

  const own = await withTenant(api, organizationA, (tx) => tx<Array<{
    edgeAuthCiphertext: string | null;
    edgeAuthNonce: string | null;
    edgeAuthTag: string | null;
    edgeAuthKeyId: string | null;
  }>>`
    select edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
           edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId"
      from runtimes where id = ${runtimeA}
  `);
  const crossTenant = await withTenant(api, organizationA, (tx) => tx<Array<{ count: string }>>`
    select count(*)::text as count from runtimes where organization_id = ${organizationB}
  `);
  assert(own.length === 1 && own[0]!.edgeAuthCiphertext && own[0]!.edgeAuthNonce && own[0]!.edgeAuthTag && own[0]!.edgeAuthKeyId === key.id,
    "0057 envelope columns were not written as a complete current-key envelope");
  assert(crossTenant[0]?.count === "0", "RLS exposed another tenant through the new envelope columns");
  assert(!own[0]!.edgeAuthCiphertext.includes("access-secret"), "Access secret was stored in plaintext");
  const decrypted = decryptSecretFromKeyring({
    ciphertext: own[0]!.edgeAuthCiphertext,
    nonce: own[0]!.edgeAuthNonce,
    tag: own[0]!.edgeAuthTag,
  }, own[0]!.edgeAuthKeyId, config.tokenEncryption);
  assert(JSON.parse(decrypted.value).clientSecret === "access-client-secret", "Stored Access envelope did not round-trip");

  const probe = await app.request(`/${runtimeA}/test`, { method: "POST" });
  assert(probe.status === 200, `POST /test returned ${probe.status}`);
  const probeDto = await probe.json() as { ok?: boolean; steps?: unknown };
  assert(probeDto.ok === true, `POST /test did not report a healthy runtime: ${JSON.stringify(probeDto.steps)}`);
  const health = requests.find((request) => request.path === "/health");
  assert(health?.authorization === "Bearer new-bearer", "API route did not decrypt the runtime bearer for the probe");
  assert(health?.clientId === "access-client-id" && health.clientSecret === "access-client-secret",
    "API route did not decrypt the Cloudflare Access envelope for the probe");

  const schema = await api<Array<{ columns: string; rowSecurity: boolean; forceRowSecurity: boolean; constraint: string | null }>>`
    select
      (select count(*)::text from information_schema.columns
        where table_schema = 'public' and table_name = 'runtimes'
          and column_name in ('edge_auth_ciphertext', 'edge_auth_nonce', 'edge_auth_tag', 'edge_auth_key_id')) as columns,
      c.relrowsecurity as "rowSecurity", c.relforcerowsecurity as "forceRowSecurity",
      (select conname from pg_constraint where conrelid = 'public.runtimes'::regclass
        and conname = 'runtimes_edge_auth_envelope') as constraint
    from pg_class c where c.oid = 'public.runtimes'::regclass
  `;
  assert(schema[0]?.columns === "4" && schema[0].rowSecurity && schema[0].forceRowSecurity && schema[0].constraint === "runtimes_edge_auth_envelope",
    "0057 schema or RLS metadata is missing");

  // A Tailscale Funnel publication needs no Cloudflare, so the whole
  // create / declare cycle runs against the real table under RLS. The tailnet
  // itself is a fake: what is proved here is the SQL, not Tailscale.
  const exposureApp = new Hono<{ Variables: AppVariables }>();
  exposureApp.use("*", async (context, next) => { context.set("auth", auth); await next(); });
  const tailnet = {
    readPolicy: async () => ({ policy: {} as Record<string, unknown>, etag: "etag-1" }),
    writePolicy: async () => { },
    listDevices: async () => [{ id: "dev-1", name: "laptop.tail1234.ts.net", hostname: "laptop", tags: [] }],
    deleteDevice: async () => { },
    createAuthKey: async () => ({ id: "key-1", key: "tskey-auth-integration" }),
    deleteAuthKey: async () => { },
  };
  exposureApp.route("/", runtimeExposureRoutes(
    api,
    { ...config, tailscaleFunnelEnabled: true, hermesEndpointPolicy: { environment: "test", testHttpUrl: endpoint } } as ApiConfig,
    { tailscaleFactory: () => tailnet },
  ));
  const createdExposure = await exposureApp.request("/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "tailscale_funnel", slug: "hermes", oauthClientId: "openedbot-client-id", oauthClientSecret: "openedbot-oauth-secret-long-enough" }),
  });
  assert(createdExposure.status === 201, `POST /exposures returned ${createdExposure.status}`);
  const exposureDto = await createdExposure.json() as { exposure: { id: string; status: string; hostname: string }; installCommand: string };
  assert(exposureDto.exposure.hostname === "hermes.tail1234.ts.net", "Funnel hostname differs");
  assert(exposureDto.installCommand.includes("sudo tailscale funnel --bg 8642"), "Funnel install command differs");
  const exposureCrossTenant = await withTenant(api, organizationB, (tx) => tx<Array<{ count: string }>>`
    select count(*)::text as count from runtime_direct_exposures
  `);
  assert(exposureCrossTenant[0]?.count === "0", "RLS exposed another tenant's publication");
  const exposureSchema = await api<Array<{ rowSecurity: boolean; forceRowSecurity: boolean; tailscaleColumn: string }>>`
    select c.relrowsecurity as "rowSecurity", c.relforcerowsecurity as "forceRowSecurity",
           (select count(*)::text from information_schema.columns
             where table_name = 'runtime_direct_exposures' and column_name = 'tailscale_auth_key_id') as "tailscaleColumn"
      from pg_class c where c.oid = 'public.runtime_direct_exposures'::regclass
  `;
  assert(exposureSchema[0]?.tailscaleColumn === "1", "0062 tailscale_auth_key_id column is missing");
  assert(exposureSchema[0]?.rowSecurity && exposureSchema[0].forceRowSecurity, "0058 RLS metadata is missing");

  console.log("Direct runtime access PostgreSQL proof passed: 0057, 0058 and 0062 schema, RLS, API envelope round-trip, probe headers and a Funnel publication.");
} finally {
  await api?.close();
  await target?.close();
  fake?.stop(true);
  if (databaseCreated) {
    await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${database} and pid <> pg_backend_pid()`;
    await admin.unsafe(`drop database "${database}"`);
  }
  await admin.close();
}
