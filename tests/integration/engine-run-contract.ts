/** The real API, queue and runner against a gateway serving only mandatory execution routes. */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { Hono } from "hono";
import { RUN_TIMEOUT_STOP_CODE } from "../../contracts/errors/src/index.ts";
import { isRunContractPayload, runContractRoute } from "../../protocol/connector/src/run-contract";
import { HermesClient } from "../../platform/hermes/src/client";
import { encryptSecret, secretEncryptionKey } from "../../platform/hermes/src/index.ts";
import { approvalRoutes } from "../../apps/api/src/routes/conversation/approval-routes";
import { conversationRoutes } from "../../apps/api/src/routes/conversation/conversation-routes";
import { claimRun } from "../../modules/execution/src/application/queue";
import { executeRun } from "../../modules/execution/src/application/runner";
import type { WorkerConfig } from "../../modules/execution/src/application/worker-config";
import type { ApiConfig } from "../../apps/api/src/infrastructure/config";
import type { BlobStore } from "../../apps/api/src/infrastructure/blob-store";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { startFakeHermes } from "../fake-hermes/server";
import { FAKE_HERMES_TOKEN } from "../fake-hermes/defaults";
import { withDisposablePostgres } from "./disposable-postgres";

const ORG = "91710000-0000-4000-8000-000000000001";
const USER = "91710000-0000-4000-8000-000000000002";
const id = (n: number) => `91710000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECTION = id(10);
const RUNTIME = id(20);
const BOT = id(101);
const THREAD = id(201);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const requests: NonNullable<Parameters<typeof startFakeHermes>[0]>["requests"] = [];
const hermes = startFakeHermes({ port: 0, delayMs: 20, capacity: 4, contractOnly: true, requests });

try {
  await withDisposablePostgres("openedbot171_engine_contract", async ({ owner: target, connect }) => {
    const api = await connect("openedbot_api");
    const worker = await connect("openedbot_worker");
    const key = secretEncryptionKey(new Uint8Array(32).fill(47));
    const endpoint = hermes.url.toString().replace(/\/$/, "");
    const bearer = encryptSecret(FAKE_HERMES_TOKEN, key.value);
    await target`insert into users (id, email) values (${USER}, 'openedbot171@example.com')`;
    await target`insert into organizations (id, slug, name) values (${ORG}, 'acme-engine-contract', 'Acme')`;
    await target`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
    await target`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Contract', 0)`;
    await target`insert into runtimes (
        id, organization_id, name, reachability, endpoint, token_ciphertext, token_nonce, token_tag, token_key_id,
        is_active, capacity, last_health_status, last_probed_at
      ) values (
        ${RUNTIME}, ${ORG}, 'Fake Hermes', 'direct', ${endpoint},
        ${bearer.ciphertext}, ${bearer.nonce}, ${bearer.tag}, ${key.id}, true, 4, 'healthy', now() + interval '1 hour'
      )`;
    await target`insert into bots (id, organization_id, section_id, name, slug, position)
      values (${BOT}, ${ORG}, ${SECTION}, 'Contract', 'contract', 0)`;
    await target`update bots set model = 'fake/hermes' where id = ${BOT}`;
    await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
      values (${THREAD}, ${ORG}, ${BOT}, 'DM', 'openedbot171-session', true)`;

    const workerConfig: WorkerConfig = {
      workerId: "openedbot171-worker",
      apiInternalUrl: "http://127.0.0.1:9",
      internalSecrets: testInternalSecrets("worker", "openedbot171"),
      tokenEncryption: { current: key, previous: [] },
      hermesMtls: null,
      hermesEndpointPolicy: { environment: "test", testHttpUrl: endpoint } as WorkerConfig["hermesEndpointPolicy"],
      leaseSeconds: 30,
      runInactivityMs: 60_000,
      // Approval scenarios finish within this bound; the stop case overrides it.
      runTimeoutMs: 15_000,
      reconciliationTimeoutMs: 10_000,
      billingEnforced: false,
      cachedInputTokenWeight: 0.1,
      webAppUrl: "http://127.0.0.1:1420",
    };
    const auth: AuthContext = {
      sessionId: "openedbot171-session", organizationId: ORG, userId: USER, role: "owner", kind: "web", credentialHash: "openedbot171",
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => { context.set("auth", auth); await next(); });
    app.route("/", conversationRoutes(api, {} as BlobStore, { billingEnforced: false } as ApiConfig));

    app.route("/approvals", approvalRoutes(api));
    const client = new HermesClient({ endpoint, token: FAKE_HERMES_TOKEN,
      policy: workerConfig.hermesEndpointPolicy!, mtls: null });
    await client.probe();
    assert((await client.toolsets())?.length === 0, "An empty toolset inventory is valid.");

    for (const scenario of ["complete", "approval", "stop"] as const) {
      const input = scenario === "complete" ? "complete the contract" : "FAKE_APPROVAL:terminal";
      const response = await app.request(`/${THREAD}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }),
      });
      const accepted = await response.json() as { runId: string };
      assert(response.status === 202, `Send ${scenario} returned ${response.status}`);
      const claimed = await claimRun(worker, workerConfig);
      assert(claimed?.id === accepted.runId, `Expected ${scenario} run to be claimed.`);
      // Stopping a paused approval is deterministic: the runner timeout must
      // stop a run that already reached the engine, then reconcile its status.
      const execution = executeRun(worker, { ...workerConfig,
        runTimeoutMs: scenario === "stop" ? 2_000 : workerConfig.runTimeoutMs }, claimed);
      try {
        if (scenario === "approval") {
          let gate: { id: string } | undefined;
          const deadline = Date.now() + 10_000;
          while (!gate && Date.now() < deadline) {
            [gate] = await target<Array<{ id: string }>>`
              select id from approval_requests where run_id = ${accepted.runId} and status = 'pending'`;
            if (!gate) await Bun.sleep(20);
          }
          assert(gate, "The runner did not persist an approval request.");
          const answer = await app.request(`/approvals/${gate.id}/respond`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice: "once" }),
          });
          assert(answer.ok, `Approval answer returned ${answer.status}`);
        }
      } finally { await execution; }
      const [run] = await target<Array<{ status: string; code: string | null; remoteStop: string | null; externalId: string | null }>>`
        select status, error_code as code, remote_stop_state as "remoteStop", hermes_run_id as "externalId"
          from runs where id = ${accepted.runId}`;
      assert(run?.externalId, `${scenario} never reached the engine.`);
      if (scenario === "stop") {
        assert(run.status === "failed" && run.code === RUN_TIMEOUT_STOP_CODE && run.remoteStop === "confirmed",
          `Running run was not stopped and confirmed: ${JSON.stringify(run)}`);
      } else {
        assert(run.status === "completed", `${scenario} failed: ${JSON.stringify(run)}`);
        const events = await target<Array<{ type: string }>>`select type from run_events where run_id = ${accepted.runId}`;
        assert(events.some((e) => e.type === "run.completed"), "Missing persisted completion.");
        if (scenario === "approval") assert(events.some((e) => e.type === "approval.responded"), "Missing approval receipt.");
        // Repeated subscriptions replay from the first event, without executing again.
        const read = async () => {
          const events = [];
          for await (const event of client.events(run.externalId!, new AbortController().signal)) events.push(event);
          return events;
        };
        const first = await read(), second = await read();
        assert(JSON.stringify(first) === JSON.stringify(second) && first[0]?.event === "message.interim",
          "A subscription must replay the same run from its first event.");
        for (const event of first) assert(isRunContractPayload("event", event), `Invalid engine event ${event.event}`);
      }
    }
    for (const request of requests) {
      assert(runContractRoute(request.method, request.path), `Undocumented request: ${request.method} ${request.path}`);
      if (request.method === "POST" && request.path === "/v1/runs") {
        assert(request.idempotencyKey, "Run creation needs Idempotency-Key.");
      }
      if (request.path === "/api/sessions" && request.method === "POST") {
        assert(isRunContractPayload("session-create", request.body), "Invalid session creation body.");
      }
      if (request.path.endsWith("/approval")) assert(isRunContractPayload("approval", request.body), "Invalid approval identity/body.");
    }
    assert(requests.some((r) => r.path === "/api/model/options"), "Exercise the optional catalogue's 404 fallback.");
    assert(requests.some((r) => r.path.includes("/messages?")), "Exercise the optional transcript's 404 fallback.");
    assert(requests.some((r) => r.path.endsWith("/stop")), "Exercise the mandatory stop route.");
    console.info(`Engine run contract passed: completion, approval, confirmed stop; ${requests.length} requests in the documented route list.`);

  });
} finally {
  hermes.stop(true);
}
