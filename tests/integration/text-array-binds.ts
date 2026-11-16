/**
 * Every query that binds a list of strings, against a real PostgreSQL.
 *
 * Bun sends a JS array bound in a tagged template as the plain string "a,b":
 * PostgreSQL refuses it with "malformed array literal", whatever the cast
 * (`${array}::text[]`, `any(${array}::text[])`). Unit tests use fake
 * databases that never parse the bind, so only this proves the SQL. The
 * array goes out as a `text[]` literal (`pgTextArray`), cast in the query.
 *
 * 1. `enqueueProfileDelete` with several slugs (deleting host profiles from
 *    the import screen failed with a 500 before 98e42ca3).
 * 2. `reconcileRuntimeSessions` over a host session inventory (the worker's
 *    unattributed-session pass threw on every host announcing a session).
 * 3. The creation-audit cross-check over dispatch hashes and remote run ids.
 */
import { testInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { enqueueProfileDelete } from "../../modules/portability/src/sql/delete-jobs";
import { reconcileRuntimeSessions } from "../../modules/runtime-link/src/application/runtime-links";
import { crossCheck } from "../../apps/api/src/routes/runtimes/runtime-audit-routes";
import type { CreationAuditEvent } from "../../platform/hermes/src/creation-audit/format";
import type { HermesClient } from "../../platform/hermes/src/client";
import {
  claimRuntimeModelSelectionProof,
  enqueueModelSelectionProof,
  executeRuntimeModelSelectionProof,
  readModelSelectionProofState,
} from "../../modules/runtimes/src/application/model-selection-proof";
import { withDisposablePostgres } from "./disposable-postgres";

const ORG = "91330000-0000-4000-8000-000000000001";
const USER = "91330000-0000-4000-8000-000000000002";
const id = (n: number) => `91330000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECTION = id(10);
const RUNTIME = id(20);
const BOT = id(30);
const THREAD = id(40);
const RUN = id(50);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await withDisposablePostgres("openedbot133_text_arrays", async ({ owner: target, connect }) => {
  const api = await connect("openedbot_api");
  const worker = await connect("openedbot_worker");
  await target`insert into users (id, email) values (${USER}, 'openedbot133@example.com')`;
  await target`insert into organizations (id, slug, name) values (${ORG}, 'acme-arrays', 'Acme')`;
  await target`insert into memberships (organization_id, user_id, role) values (${ORG}, ${USER}, 'owner')`;
  await target`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Arrays', 0)`;
  await target`insert into runtimes (
      id, organization_id, name, reachability, link_token_hash, is_active, link_connected_at,
      last_health_status, link_features
    ) values (
      ${RUNTIME}, ${ORG}, 'Linked host', 'connector', 'arrays-fixture-hash', true, now(),
      'healthy', '{profile_management,sessions_inventory}'::text[]
    )`;
  // The session pass only reads a link held by a live API instance.
  await target`insert into api_instances (instance_id, internal_url) values ('api-arrays-fixture', 'http://api.invalid:8790')`;
  await target`update runtimes set link_instance_id = 'api-arrays-fixture', link_last_seen_at = now() where id = ${RUNTIME}`;
  await target`insert into bots (id, organization_id, section_id, name, slug, position)
    values (${BOT}, ${ORG}, ${SECTION}, 'Camille', 'camille', 0)`;
  await target`insert into threads (id, organization_id, bot_id, title, hermes_session_id, is_default)
    values (${THREAD}, ${ORG}, ${BOT}, 'DM', 'known-session', true)`;

  // 1. Several host profiles deleted in one job.
  const slugs = ["scout", "pilote-live", "camille_2"];
  const job = await enqueueProfileDelete(api, ORG, USER, RUNTIME, slugs);
  assert(Bun.deepEquals(job.slugs, slugs) && job.totalProfiles === 3, `delete job ${JSON.stringify(job)}`);
  const [stored] = await target<Array<{ slugs: string[]; type: string }>>`
    select slugs, pg_typeof(slugs)::text as type from profile_delete_jobs where id = ${job.id}`;
  assert(stored?.type === "text[]" && Bun.deepEquals(stored.slugs, slugs), `stored slugs ${JSON.stringify(stored)}`);

  // 2. The worker's session inventory pass: one known session, one stranger,
  // flagged once and only once.
  const inventory = {
    sessions: [
      { id: "known-session", profile: "camille", createdAt: "2026-10-24T00:00:00Z" },
      { id: "stranger-session", profile: "scout", createdAt: "2026-10-24T00:01:00Z" },
    ],
  };
  const options = {
    apiInternalUrl: "http://link.invalid",
    internalSecrets: testInternalSecrets("worker", "openedbot133"),
    fetchImpl: async () => Response.json(inventory),
  };
  const first = await reconcileRuntimeSessions(worker, options);
  assert(first.runtimes === 1 && first.unattributed === 1, `first session pass ${JSON.stringify(first)}`);
  const second = await reconcileRuntimeSessions(worker, options);
  assert(second.unattributed === 0, `the stranger was flagged twice: ${JSON.stringify(second)}`);
  const flagged = await target<Array<{ sessionId: string }>>`
    select meta->>'sessionId' as "sessionId" from runtime_link_events
     where organization_id = ${ORG} and kind = 'unattributed_session'`;
  assert(flagged.length === 1 && flagged[0]!.sessionId === "stranger-session", `flagged ${JSON.stringify(flagged)}`);

  // 3. The creation-audit cross-check.
  const known = "a".repeat(64);
  const unknown = "b".repeat(64);
  await target`insert into runtime_link_dispatches (organization_id, runtime_id, instance_id, idempotency_key_hash, dispatched_at)
    values (${ORG}, ${RUNTIME}, 'arrays', ${known}, now())`;
  await target`insert into runs (id, organization_id, thread_id, bot_id, input, status, hermes_run_id)
    values (${RUN}, ${ORG}, ${THREAD}, ${BOT}, 'audit', 'completed', 'remote-known')`;
  const event = (eventId: string, phase: string, hash: string, remoteId?: string): CreationAuditEvent => ({
    eventId, attemptId: eventId, phase, occurredAt: new Date().toISOString(), runtimeId: RUNTIME, profile: "camille",
    correlationId: eventId, idempotencyKeyHash: hash, method: "POST", path: "/v1/runs", ...(remoteId ? { remoteId } : {}),
  });
  const findings = await api.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${ORG}, true)`;
    return crossCheck(tx, ORG, RUNTIME, [
      event("e1", "attempt", known),
      event("e2", "attempt", unknown),
      event("e3", "outcome", known, "remote-known"),
      event("e4", "outcome", known, "remote-missing"),
    ]);
  });
  assert(Bun.deepEquals(findings, [
    { kind: "unknown_dispatch", eventId: "e2" },
    { kind: "unknown_remote_id", eventId: "e4" },
  ]), `audit findings ${JSON.stringify(findings)}`);

  // 4. The sister defect: a JSON string bound to a `jsonb` parameter is
  // encoded once more and stored as a JSON string scalar. The session
  // inventory pass above already proves its event `meta` (the column checks
  // `jsonb_typeof(meta) = 'object'`); a failed model proof must store and
  // read back its error as an object, or the console has no code to show.
  await enqueueModelSelectionProof(api, { organizationId: ORG, runtimeId: RUNTIME, provider: null, model: null, reasoningEffort: null });
  const proofJob = await claimRuntimeModelSelectionProof(worker, "openedbot133-worker");
  assert(proofJob, "the model proof was not claimed");
  const refusing = {
    createRun: async () => { throw new Error("refused by the fixture"); },
  } as unknown as HermesClient;
  await executeRuntimeModelSelectionProof(worker, proofJob, {
    client: () => refusing,
    withProfileNamesLock: async (_organizationId, _names, callback) => callback(),
    profileServeWait: { timeoutMs: 1, pollMs: 1, sleep: async () => undefined },
    rewriteFollowers: async () => undefined,
  });
  const proof = await readModelSelectionProofState(api, ORG, RUNTIME);
  const [proofType] = await target<Array<{ type: string }>>`
    select jsonb_typeof(error) as type from runtime_model_selection_proofs where runtime_id = ${RUNTIME}`;
  assert(proof?.status === "failed" && proofType?.type === "object"
    && typeof (proof.error as { code?: unknown } | null)?.code === "string",
    `failed model proof error ${JSON.stringify({ status: proof?.status, error: proof?.error, type: proofType?.type })}`);

  console.info("Text array binds passed: profile delete slugs, session inventory reconciliation and the creation-audit cross-check bind their lists as text[] literals; jsonb event meta and model proof errors are stored as objects.");
});
