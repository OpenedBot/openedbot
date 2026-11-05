/** Requires an explicitly provisioned disposable database with every migration. */
import { SQL } from "bun";
import { Hono } from "hono";
import { hermesBundleImportRoutes } from "../../src/routes/portability/hermes-bundle-import-routes";
import type { AppVariables, AuthContext } from "../../src/routes/identity/auth";
import type { ApiConfig } from "../../src/infrastructure/config";
import { expect } from "bun:test";
import { HermesClient, HermesClientError } from "@openedbot/hermes";
import { parseHermesProfileFiles } from "@openedbot/portability/domain/hermes-profile-bundle";
import { claimProfileImport, executeProfileImport, type ImportExecutorClient } from "@openedbot/portability/application/executor";
import { importHermesProfile } from "@openedbot/portability/sql/roster";
import { acknowledgeImportJob, enqueueProfileImport, findIdempotentImport, readImportJob, withImportTenant } from "@openedbot/portability/sql/jobs";
import { withProfileNamesLock, withBotProfileLock } from "@openedbot/portability/application/profile-import-guard";
import { startFakeHermes } from "../../../../tests/fake-hermes/server";

const url = process.env.INTEGRATION_ADMIN_DATABASE_URL;
if (!url || !/^\/openedbot56_import_[a-z0-9_]+$/.test(new URL(url).pathname)) throw new Error("Explicit disposable openedbot56_import_* database required");
const db = new SQL({ url, max: 5 });
const api = new SQL({ url, max: 1 });
const worker = new SQL({ url, max: 3, connection: { options: "-c role=openedbot_worker" } });
const fake = startFakeHermes({ port: 0, token: "import-fixture" });
const origin = `127.0.0.1:${fake.port}`;
const client = new HermesClient({ endpoint: `http://${origin}`, token: "import-fixture", policy: { environment: "development", insecureOrigins: new Set([origin]) }, mtls: null });
const org = crypto.randomUUID(), other = crypto.randomUUID(), user = crypto.randomUUID(), runtime = crypto.randomUUID(), section = crypto.randomUUID();
const blobs = { driver: "file" as const, put: async () => {}, delete: async () => {} };
const input = (...slugs: string[]) => ({ idempotencyKey: crypto.randomUUID(), profiles: slugs.map((slug) => {
  const parsed = parseHermesProfileFiles(slug, { "config.yaml": new TextEncoder().encode("name: " + slug + "\nmodel: {default: fake/hermes, provider: fake}\nplatform_toolsets:\n  api_server: {web: false}\n") });
  if (!("entry" in parsed)) throw new Error("fixture");
  return parsed.entry;
}) });
const execute = async (override: Partial<ImportExecutorClient> = {}) => {
  const job = await claimProfileImport(worker, "test-worker");
  expect(job).not.toBeNull();
  const proxy = new Proxy(client, { get: (target, key) => key in override ? override[key as keyof ImportExecutorClient] : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) });
  await executeProfileImport(worker, job!, { client: () => proxy, blobs });
  return readImportJob(api, org, job!.id);
};
try {
  await db`insert into organizations (id, slug, name) values (${org}, ${`import-${org}`}, 'Import fixture'), (${other}, ${`import-${other}`}, 'Other fixture')`;
  await db`insert into users (id, email) values (${user}, ${`${user}@example.test`})`;
  await db`insert into memberships (organization_id, user_id, role) values (${org}, ${user}, 'owner')`;
  await db`insert into sections (id, organization_id, name, position) values (${section}, ${org}, 'Import', 0)`;
  await db`insert into runtimes (id, organization_id, name, reachability, link_token_hash, is_active, link_features, selected_provider, selected_model)
    values (${runtime}, ${org}, 'Import fixture', 'connector', ${runtime}, true, array['profile_management', 'profile_capabilities'], 'fake', 'fake/hermes')`;
  await api`set role openedbot_api`;
  // Actual runtime INSERT proves column alignment, unmanaged ownership and rollback.
  await withImportTenant(api, org, async (tx) => {
    await importHermesProfile(tx, { organizationId: org, userId: user, sectionId: section, position: 0, managed: false, model: null }, input("runtime-adopted").profiles[0]!, null);
  });
  const adopted = await db`select reasoning_effort, hermes_profile, hermes_profile_managed from bots where organization_id = ${org}`;
  expect(adopted[0]).toMatchObject({ reasoning_effort: null, hermes_profile: 'runtime-adopted', hermes_profile_managed: false });
  // A single-slot pool can execute short transactions inside the host lock.
  await withProfileNamesLock(api, org, ["free"], (connection) => withImportTenant(connection, org, async (tx) => { await tx`select 1`; }));

  await expect(withProfileNamesLock(api, org, ["free"], (connection) => withImportTenant(connection, org, async () => { throw new Error("guard rollback fixture"); }))).rejects.toThrow("guard rollback fixture");

  const request = input("scout", "editor");
  let runtimeConnected = true;
  let routeAuth: AuthContext = { sessionId: "fixture", organizationId: org, userId: user, role: "owner", kind: "web", credentialHash: "fixture" };
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (context, next) => { context.set("auth", routeAuth); await next(); });
  routes.route("/api/team-imports/hermes-bundle", hermesBundleImportRoutes(api, {} as ApiConfig, async () => runtimeConnected ? { id: runtime, linkFeatures: ["profile_management"] } as never : null));
  const post = () => routes.request("/api/team-imports/hermes-bundle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  const accepted = await post(); expect(accepted.status).toBe(202);
  const queued = await accepted.json() as Awaited<ReturnType<typeof enqueueProfileImport>>;
  runtimeConnected = false;
  expect((await post()).status).toBe(202);
  expect((await routes.request(`/api/team-imports/hermes-bundle/jobs/${queued.id}`)).status).toBe(200);
  expect((await routes.request("/api/team-imports/hermes-bundle/jobs")).status).toBe(200);
  routeAuth = { ...routeAuth, role: "member" };
  expect((await post()).status).toBe(403);
  expect((await routes.request("/api/team-imports/hermes-bundle/jobs")).status).toBe(403);
  routeAuth = { ...routeAuth, role: "owner", organizationId: other };
  expect((await routes.request(`/api/team-imports/hermes-bundle/jobs/${queued.id}`)).status).toBe(404);
  routeAuth = { ...routeAuth, organizationId: org };
  expect((await enqueueProfileImport(api, org, user, runtime, request)).id).toBe(queued.id);
  await expect(findIdempotentImport(api, org, { ...request, profiles: input("different").profiles })).rejects.toThrow();
  await expect(readImportJob(api, other, queued.id)).rejects.toThrow();
  await expect(withProfileNamesLock(api, org, ["scout"], async () => {})).rejects.toThrow();
  const claims = await Promise.all([claimProfileImport(worker, "a"), claimProfileImport(worker, "b")]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  await executeProfileImport(worker, claims.find(Boolean)!, { client: () => client, blobs });
  let result = await readImportJob(api, org, queued.id);
  expect(result.status).toBe("succeeded"); expect(result.result?.imported).toHaveLength(2);
  expect(result.result?.capabilities[0]?.toolsets).toContainEqual({ name: "web", enabled: false });
  expect(result.result?.capabilities[0]?.toolsets).toContainEqual({ name: "memory", enabled: true });
  expect((await db<Array<{ entry: unknown }>>`select entry from profile_import_items where job_id = ${queued.id}`).every((row) => row.entry === null)).toBe(true);
  const scoutId = result.result!.imported[0]!.botId;
  await withBotProfileLock(api, org, scoutId, (connection) => withImportTenant(connection, org, async (tx) => { await tx`select 1`; }));

  // PROFILE_EXISTS must never delete a pre-existing host profile.
  await client.hostCreateProfile("existing");
  await enqueueProfileImport(api, org, user, runtime, input("existing"));
  let deletes = 0;
  result = await execute({ hostDeleteProfile: async () => { deletes++; } });
  expect(result.status).toBe("failed"); expect(deletes).toBe(0);
  expect((await client.hostProfileInventory()).profiles.some((p) => p.name === "existing")).toBe(true);

  // A committed intent with a lost response never replays create or compensates.
  const ambiguous = await enqueueProfileImport(api, org, user, runtime, input("uncertain"));
  result = await execute({ hostCreateProfile: async () => { throw new Error("lost response"); }, hostDeleteProfile: async () => { deletes++; } });
  expect(result.status).toBe("needs_attention"); expect(deletes).toBe(0);
  await expect(withProfileNamesLock(api, org, ["uncertain"], async () => {})).rejects.toThrow();
  await expect(acknowledgeImportJob(api, org, user, ambiguous.id)).rejects.toThrow();
  await db`update profile_import_jobs set review_after = now() - interval '1 second' where id = ${ambiguous.id}`;
  expect((await acknowledgeImportJob(api, org, user, ambiguous.id)).status).toBe("failed");
  await withProfileNamesLock(api, org, ["uncertain"], async () => {});

  // Crash after intent persisted and a new generation claims the expired job.
  const crash = await enqueueProfileImport(api, org, user, runtime, input("crashed"));
  const stale = await claimProfileImport(worker, "old");
  await db`update profile_import_items set operation = '{"kind":"create"}', creation_state = 'sending' where job_id = ${crash.id}`;
  await db`update profile_import_jobs set lease_expires_at = now() - interval '1 second' where id = ${crash.id}`;
  result = await execute({ hostCreateProfile: async () => { throw new Error("must not replay"); } });
  expect(result.status).toBe("needs_attention");
  let dispatched = 0;
  await executeProfileImport(worker, stale!, { client: () => new Proxy(client, { get: (target, key) => key === "hostCreateProfile" ? async () => { dispatched++; throw new Error(); } : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) }), blobs });
  expect(dispatched).toBe(0);

  // Roster constraint failure rolls back ALL bots; confirmed creations compensate.
  await db`create function import_test_reject() returns trigger language plpgsql as $$ begin if new.slug = 'reject-second' then raise exception 'fixture SQL failure'; end if; return new; end $$`;
  await db`create trigger import_test_reject before insert on bots for each row execute function import_test_reject()`;
  await enqueueProfileImport(api, org, user, runtime, input("rollback-first", "reject-second"));
  result = await execute();
  expect(result.status).toBe("failed");
  expect(await db`select id from bots where organization_id = ${org} and slug in ('rollback-first','reject-second')`).toHaveLength(0);
  expect((await client.hostProfileInventory()).profiles.some((p) => ["rollback-first", "reject-second"].includes(p.name))).toBe(false);
  await db`drop trigger import_test_reject on bots`; await db`drop function import_test_reject()`;

  // Lost commit acknowledgement: the durable capabilities phase prevents cleanup.
  const commitJob = await enqueueProfileImport(api, org, user, runtime, input("commit-uncertain"));
  const commitClaim = await claimProfileImport(worker, "commit-worker");
  let commitLost = false; let commitDeletes = 0;
  const uncertainDb = new Proxy(worker, { get(target, key) {
    if (key === "begin") return async (fn: (tx: Bun.TransactionSQL) => Promise<unknown>) => {
      const value = await target.begin(fn);
      const rows = await db`select phase from profile_import_jobs where id = ${commitJob.id}`;
      if (!commitLost && rows[0]?.phase === "capabilities") { commitLost = true; throw new Error("lost commit acknowledgement"); }
      return value;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const noDeleteClient = new Proxy(client, { get(target, key) {
    if (key === "hostDeleteProfile") return async () => { commitDeletes++; };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await executeProfileImport(uncertainDb, commitClaim!, { client: () => noDeleteClient, blobs });
  result = await readImportJob(api, org, commitJob.id);
  expect(commitLost).toBe(true); expect(result.status).toBe("succeeded"); expect(result.result?.imported).toHaveLength(1); expect(commitDeletes).toBe(0);

  // A lost response after an actual creation remains reserved, with no replay.
  const afterResponse = await enqueueProfileImport(api, org, user, runtime, input("after-response"));
  const responseClaim = await claimProfileImport(worker, "response-worker");
  const abort = new AbortController();
  const responseClient = new Proxy(client, { get(target, key) {
    if (key === "hostCreateProfile") return async (...args: Parameters<HermesClient["hostCreateProfile"]>) => { const profile = await target.hostCreateProfile(...args); abort.abort(); return profile; };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await executeProfileImport(worker, responseClaim!, { client: () => responseClient, blobs, signal: abort.signal });
  await db`update profile_import_jobs set lease_expires_at = now() - interval '1 second' where id = ${afterResponse.id}`;
  result = await execute(); expect(result.status).toBe("needs_attention");
  expect((await client.hostProfileInventory()).profiles.filter((p) => p.name === "after-response")).toHaveLength(1);

  // Deleted section rolls the entire roster back; unverified deletion remains visible.
  const removedSection = crypto.randomUUID();
  await db`insert into sections (id, organization_id, name, position) values (${removedSection}, ${org}, 'Temporary', 1)`;
  await enqueueProfileImport(api, org, user, runtime, { ...input("cleanup-unconfirmed"), sectionId: removedSection });
  await db`delete from sections where id = ${removedSection}`;
  result = await execute({ hostDeleteProfile: async () => { throw new HermesClientError("delete unverified", 502, "PROFILE_UNVERIFIED"); } });
  expect(result.status).toBe("needs_attention"); expect(result.error?.details?.unconfirmedProfiles).toContain("cleanup-unconfirmed");
  expect(await db`select id from bots where organization_id = ${org} and slug = 'cleanup-unconfirmed'`).toHaveLength(0);

  // The shared lock serializes an actual adoption against a simultaneous bundle.
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const concurrentApi = new SQL({ url, max: 1, connection: { options: "-c role=openedbot_api" } });
  try {
    const adoption = withProfileNamesLock(api, org, ["race-adopted"], async (connection) => {
      await withImportTenant(connection, org, async (tx) => {
        await importHermesProfile(tx, { organizationId: org, userId: user, sectionId: section, position: 100, managed: false, model: null }, input("race-adopted").profiles[0]!, null);
      });
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    let settled = false;
    const racing = enqueueProfileImport(concurrentApi, org, user, runtime, input("race-adopted")).then(() => { settled = true; throw new Error("collision accepted"); }, (error) => { settled = true; return error; });
    await new Promise((resolve) => setTimeout(resolve, 15)); expect(settled).toBe(false);
    release.resolve(); await adoption;
    expect(await racing).toHaveProperty("code", "PROFILE_ALREADY_IMPORTED");
  } finally { release.resolve(); await concurrentApi.close(); }

  // A restart during compensation retains the original public failure.
  const resumed = await enqueueProfileImport(api, org, user, runtime, input("resume-cleanup"));
  await client.hostCreateProfile("resume-cleanup");
  await db`update profile_import_items set creation_state = 'created' where job_id = ${resumed.id}`;
  await db`update profile_import_jobs set phase = 'compensation', error = '{"code":"HERMES_PROFILE_EXISTS","message":"Existing profile"}' where id = ${resumed.id}`;
  result = await execute(); expect(result.status).toBe("failed"); expect(result.error?.code).toBe("HERMES_PROFILE_EXISTS");

  // Queue pins runtime and section; a changed runtime is detected before create.
  const moved = await enqueueProfileImport(api, org, user, runtime, input("moved"));
  await db`update runtimes set is_active = false where id = ${runtime}`;
  result = await execute(); expect(result.id).toBe(moved.id); expect(result.status).toBe("failed");
  console.info("Profile import PostgreSQL proofs passed: SQL alignment, RLS, idempotence, single-slot guard, competing workers, flags/inheritance, ambiguity, stale lease, atomic rollback, compensation and runtime replacement.");
} finally {
  fake.stop(true);
  await api.close(); await worker.close(); await db.close();
}
