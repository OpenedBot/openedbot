/** Real bot API, provisioning, runner and cleanup against the bounded ACP contracts. */
import { Hono } from "hono";
import { testInternalSecrets, internalBearer } from "@openedbot/platform-config/internal-secrets";
import { HermesClient, createRelayTransport, secretEncryptionKey } from "../../platform/hermes/src/index";
import { botRoutes } from "../../apps/api/src/routes/roster/bot-routes";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import { processProfileProvision } from "../../apps/worker/src/maintenance/profile-provisions";
import { processBotHostCleanup } from "../../apps/worker/src/maintenance/bot-host-cleanups";
import { claimRun } from "../../modules/execution/src/application/queue";
import { executeRun } from "../../modules/execution/src/application/runner";
import { runContractRoute } from "../../protocol/connector/src/run-contract";
import type { WorkerConfig } from "../../apps/worker/src/config";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { withDisposablePostgres } from "./disposable-postgres";
import { startFakeHermes, type FakeHermesOptions } from "../fake-hermes/server";
import { FAKE_HERMES_TOKEN } from "../fake-hermes/defaults";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const ORG = crypto.randomUUID(), USER = crypto.randomUUID(), RUNTIME = crypto.randomUUID(), SECTION = crypto.randomUUID();
const requests: NonNullable<FakeHermesOptions["requests"]> = [];
const hostRequests: NonNullable<FakeHermesOptions["hostRequests"]> = [];
const gateway = startFakeHermes({ port: 0, contractOnly: true, profileManagementOnly: true, delayMs: 20, requests, hostRequests });
const secrets = testInternalSecrets("worker", "engine-profile-contract");
// Transport fixture only: the production worker still builds its relay client,
// including /p/<slug>, and the fake gateway enforces profile existence.
const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/internal/events/publish") {
    assert(request.headers.get("Authorization") === internalBearer(secrets, "events"), "Unexpected events credential");
    return Response.json({ ok: true });
  }
  assert(request.headers.get("Authorization") === internalBearer(secrets, "relay"), "Unexpected relay credential");
  const url = new URL(request.url);
  const prefix = `/internal/runtime-links/${RUNTIME}/proxy`;
  assert(url.pathname.startsWith(prefix), "Unexpected relay destination");
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${FAKE_HERMES_TOKEN}`);
  return fetch(`${gateway.url.origin}${url.pathname.slice(prefix.length)}${url.search}`, {
    method: request.method, headers, body: request.body, signal: request.signal,
  });
} });
try {
  await withDisposablePostgres("openedbot171_engine_profiles", async ({ owner, connect }) => {
    const api = await connect("openedbot_api"), worker = await connect("openedbot_worker");
    const transport = createRelayTransport({ runtimeId: RUNTIME, dial: (request, signal) => fetch(
      `${relay.url.origin}/internal/runtime-links/${RUNTIME}/proxy${request.path}`, {
        method: request.method, headers: { ...request.headers, Authorization: internalBearer(secrets, "relay") }, body: request.body instanceof Uint8Array ? Uint8Array.from(request.body).buffer : request.body, signal,
      }),
    });
    const client = new HermesClient({ transport });
    const features = await client.hostCapabilities();
    assert(JSON.stringify(features) === '["profile_management"]', "Only profile_management may be announced");
    await owner`insert into users (id, email) values (${USER}, 'engine-profile@example.test')`;
    await owner`insert into organizations (id, slug, name) values (${ORG}, ${`engine-${ORG}`}, 'Engine contract')`;
    await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
    await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Engine', 0)`;
    await owner`insert into runtimes (id, organization_id, name, reachability, is_active, capacity, link_features, link_last_seen_at, link_token_hash)
      values (${RUNTIME}, ${ORG}, 'ACP fixture', 'connector', true, 4, ${features}, now(), 'engine-profile-fixture')`;
    const config = {
      workerId: "engine-profile-worker", apiInternalUrl: relay.url.origin, internalSecrets: secrets,
      tokenEncryption: { current: secretEncryptionKey(new Uint8Array(32).fill(48)), previous: [] }, hermesMtls: null,
      hermesEndpointPolicy: { environment: "test", testHttpUrl: gateway.url.origin }, leaseSeconds: 30,
      runInactivityMs: 20_000, runTimeoutMs: 30_000, reconciliationTimeoutMs: 10_000,
      billingEnforced: false, cachedInputTokenWeight: 0.1, webAppUrl: "http://127.0.0.1:1420",
      botHostCleanupVerifyDelaySeconds: 0,
    } as unknown as WorkerConfig;
    const auth: AuthContext = { sessionId: "engine-profile", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "engine-profile" };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
    app.route("/bots", botRoutes(api, {} as ApiConfig, {
      readRuntime: async () => ({ id: RUNTIME, name: "ACP fixture", capacity: 4, linkFeatures: features!, client: { transport }, selectedProvider: null, selectedModel: null, reasoningEffort: null }),
    }));
    app.route("/conversations", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));
    const created = await app.request("/bots", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ACP bot", slug: "acp-bot", sectionId: SECTION }),
    });
    const bot = await created.json() as { id: string };
    assert(created.status === 201, `Bot creation returned ${created.status}: ${JSON.stringify(bot)}`);
    const [stored] = await owner`select hermes_profile, hermes_profile_managed from bots where id = ${bot.id}`;
    assert(stored?.hermes_profile === "acp-bot" && stored.hermes_profile_managed, "Bot must own a managed profile");
    await processProfileProvision(worker, config, new AbortController().signal);
    const [provision] = await owner`select status, error from bot_profile_provisions where bot_id = ${bot.id}`;
    assert(provision?.status === "succeeded", `Provision failed: ${JSON.stringify(provision)}`);
    assert((await client.hostProfileInventory()).profiles.some((p) => p.name === "acp-bot"), "Created profile missing");
    const [thread] = await owner`select id from threads where bot_id = ${bot.id} and is_default`;
    assert(thread, "Bot must have its default conversation");
    const sent = await app.request(`/conversations/${thread.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "Complete the first ACP run" }) });
    const accepted = await sent.json() as { runId: string };
    assert(sent.status === 202, `Message returned ${sent.status}: ${JSON.stringify(accepted)}`);
    const run = await claimRun(worker, config);
    assert(run?.id === accepted.runId, "First run must be claimed");
    await executeRun(worker, config, run);
    const [completed] = await owner`select status, error_code from runs where id = ${accepted.runId}`;
    assert(completed?.status === "completed", `First run failed: ${JSON.stringify(completed)}`);
    assert(requests.some((r) => r.method === "POST" && r.path === "/p/acp-bot/v1/runs"), "First run must use /p/<slug>");
    const deleted = await app.request(`/bots/${bot.id}`, { method: "DELETE" });
    assert(deleted.status === 200, `Deletion returned ${deleted.status}: ${await deleted.text()}`);
    for (let pass = 0; pass < 2; pass++) await processBotHostCleanup(worker, config, new AbortController().signal);
    const [cleanup] = await owner`select status, error from bot_host_cleanups where bot_id = ${bot.id}`;
    assert(cleanup?.status === "succeeded", `Cleanup failed: ${JSON.stringify(cleanup)}`);
    const [archived] = await owner`select deleted_at from bots where id = ${bot.id}`;
    assert(archived?.deleted_at, "Bot must be deleted");
    assert(!(await client.hostProfileInventory()).profiles.some((p) => p.name === "acp-bot"), "Profile must be deleted");
    const scoped = new HermesClient({ transport, profile: "acp-bot" });
    assert(await scoped.probeProfileIsolation("acp-bot") === "missing", "Deleted profile must no longer be served");

    for (const request of hostRequests) {
      const management = (request.path === "/hermes-setup/profiles" && ["GET", "POST"].includes(request.method))
        || (request.path === "/hermes-setup/profiles/acp-bot" && request.method === "DELETE");
      const discovery = request.path === "/hermes-setup/capabilities" && request.method === "GET";
      // The worker's speculative toolset prefetch predates its baseline gate.
      // Refusal is already tolerated; it must never become a served ACP route.
      const refusedPrefetch = request.path === "/hermes-setup/toolsets" && request.method === "GET" && request.status === 404;
      assert(management || discovery || refusedPrefetch, `Unannounced host request: ${JSON.stringify(request)}`);
      if (request.status < 400) assert(management || discovery, "Every served request must belong to the announced capability");
    }
    assert(hostRequests.filter((r) => r.path === "/hermes-setup/toolsets").length === 1, "Exercise the tolerated prefetch refusal exactly once");
    for (const request of requests.filter((r) => !r.path.startsWith("/hermes-setup/"))) {
      if (request.method === "POST" && request.path.endsWith("/v1/runs")) {
        const body = request.body as { model?: string; provider?: string };
        assert(body.model === "agent-default" && body.provider === "acp", "Run must use the configured agent default");
      }
      assert(runContractRoute(request.method, request.path), `Gateway request outside execution contract: ${request.method} ${request.path}`);
      if (request.path.endsWith("/model") || request.path.includes("/memory") || request.path.includes("/skills")) throw new Error("Unexpected profile configuration request");
    }
    console.info(JSON.stringify({ event: "engine_profile.host_requests", requests: hostRequests }));
    console.info(`Engine profile contract passed: managed creation, first /p/acp-bot run completed, bot and profile deleted; ${hostRequests.length} host requests, only profile management served and one tolerated toolsets refusal.`);
  });
} finally { relay.stop(true); gateway.stop(true); }
