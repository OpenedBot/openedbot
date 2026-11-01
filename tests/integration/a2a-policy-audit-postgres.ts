// First import: the logger is built when platform/observability loads, and
// its asynchronous file destination could still be opening when this short
// script exits (pino then throws "sonic boom is not ready yet" from its exit
// hook and the exit code no longer reflects the proof).
import "./sync-logger";
import { SQL } from "bun";
import type { A2AAuditPageDto } from "@openedbot/contracts-api";
import { withTenant } from "../../platform/db/src/db";
import {
  readAgencyA2AAuditPage,
  refreshAgencyA2AAudit,
} from "../../modules/runtimes/src/application/a2a-audit";
import { adminUrl, withDisposablePostgres } from "./disposable-postgres";

const USER = "84000000-0000-4000-8000-000000000011";
const CLIENT_OWNER = "84000000-0000-4000-8000-000000000012";
const AGENCY = "84000000-0000-4000-8000-000000000013";
const CLIENT_A = "84000000-0000-4000-8000-000000000014";
const CLIENT_B = "84000000-0000-4000-8000-000000000015";
const CLIENT_DENIED = "84000000-0000-4000-8000-000000000016";
const RUNTIME_A = "84000000-0000-4000-8000-000000000021";
const RUNTIME_B = "84000000-0000-4000-8000-000000000022";
const RUNTIME_DENIED = "84000000-0000-4000-8000-000000000023";
const TASK_UPSTREAM = "task-0123456789abcdef";
const TASK_PROBE = "task-fedcba9876543210";
const SAME_TS = 1_760_000_000;
const REPORT_PATH = "/tmp/ohb84-audit-postgres.json";

const report: Record<string, boolean | number> = {
  ownerUrlLoopbackValidated: false,
  freshDatabaseNameValidated: false,
  databaseCreatedAndDropped: false,
  migrationsApplied: 0,
  migration0097Applied: false,
  initialInserted: 0,
  duplicateReimport: 0,
  invalidRecordsDropped: 0,
  sameOffsetAcrossFiles: false,
  policyGuardTaskStoredNull: false,
  upstreamAndProbeTasksRequired: false,
  crossFileCursorOrderStable: false,
  changedPayloadCollisionRejected: false,
  tenantRlsIsolation: false,
  workerSelectDenied: false,
  revokedBeforeReadAndImport: false,
  inFlightRevocationPreventsImport: false,
  inFlightFailureMaskedByRevocation: false,
  sqlCheckConstraintsRejectInvalidPairs: false,
  unknownMetadataNotStoredOrProjected: false,
  complete: false,
};

type Scope = { userId: string; agencyId: string; clientId: string };
type SnapshotRecord = Record<string, unknown>;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function snapshot(records: SnapshotRecord[], overrides: Record<string, unknown> = {}) {
  return {
    status: "available",
    source: "a2a_audit",
    limit: 10,
    truncated: false,
    skippedRecords: 0,
    records,
    ...overrides,
  };
}

function upstream(offset: number, ts: number, overrides: Record<string, unknown> = {}): SnapshotRecord {
  return {
    id: `a2a_audit:${offset}`,
    source: "upstream",
    ts,
    direction: "inbound",
    peer: "peer_upstream",
    taskId: TASK_UPSTREAM,
    summary: "DROP_A2A_PROMPT_SENTINEL",
    tokens: { credential: "DROP_A2A_TOKEN_SENTINEL" },
    organizationId: CLIENT_B,
    runtimeId: RUNTIME_B,
    ...overrides,
  };
}

function policyProbe(offset: number, ts: number, overrides: Record<string, unknown> = {}): SnapshotRecord {
  return {
    id: `a2a_audit:${offset}`,
    source: "operator.policy_probe",
    ts,
    direction: "denied",
    peer: "peer_probe",
    taskId: TASK_PROBE,
    summary: "",
    ...overrides,
  };
}

function policyGuard(offset: number, ts: number): SnapshotRecord {
  return {
    id: `policy_denials:${offset}`,
    source: "operator.policy_guard",
    ts,
    direction: "denied",
    peer: "peer_guard",
    summary: "DROP_GUARD_SUMMARY_SENTINEL",
    tokens: { credential: "DROP_GUARD_TOKEN_SENTINEL" },
  };
}

function envValue(source: string): string | null {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?DEV_RESET_DATABASE_URL\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    const quote = raw[0];
    if ((quote === "'" || quote === '"') && raw.endsWith(quote)) return raw.slice(1, -1);
    return raw;
  }
  return null;
}

async function ownerAdminUrl(): Promise<string> {
  // CI (and any caller of `make test-integration` with an explicit admin URL)
  // already names the loopback owner connection; the private local env file is
  // only the fallback of a developer machine.
  let raw = process.env.INTEGRATION_ADMIN_DATABASE_URL?.trim() || process.env.DEV_RESET_DATABASE_URL?.trim() || null;
  if (!raw && process.env.OHB84_ENV_FILE) raw = envValue(await Bun.file(process.env.OHB84_ENV_FILE).text());
  // `make test-integration` passes no setting: the same dev-infra container
  // discovery as every other integration script.
  if (!raw) raw = (await adminUrl()).toString();
  if (!raw) throw new Error("The private local owner database setting is unavailable.");
  const url = new URL(raw);
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("The database owner connection is not a loopback PostgreSQL URL.");
  }
  // The port comes from the URL, else PGPORT, else 5432: a throwaway
  // PostgreSQL on another loopback port is as valid as the dev one. The
  // loopback host above is the safety check, not the port.
  const port = url.port || process.env.PGPORT?.trim() || "5432";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("The database owner port is not a valid TCP port.");
  }
  url.hostname = "127.0.0.1";
  url.port = port;
  url.pathname = "/postgres";
  url.hash = "";
  report.ownerUrlLoopbackValidated = true;
  return url.toString();
}

async function expectCheckConstraint(owner: SQL, input: {
  source: string;
  offset: number;
  sourceKind: string;
  direction: string;
  peer: string;
  taskId: string | null;
}): Promise<boolean> {
  try {
    await owner`insert into runtime_a2a_audit
      (organization_id, runtime_id, source, source_offset, source_kind, ts, direction, peer, task_id)
      values (${CLIENT_A}, ${RUNTIME_A}, ${input.source}, ${input.offset}, ${input.sourceKind}, ${SAME_TS},
        ${input.direction}, ${input.peer}, ${input.taskId})`;
    return false;
  } catch (error) {
    return error instanceof Error;
  }
}

async function run(): Promise<void> {
  const previousAdminUrl = process.env.INTEGRATION_ADMIN_DATABASE_URL;
  let disposableDatabaseName: string | null = null;
  let failed = false;
  try {
    process.env.INTEGRATION_ADMIN_DATABASE_URL = await ownerAdminUrl();
    await withDisposablePostgres("ohb84_audit_policy", async ({ owner, connect }) => {
      const current = await owner<Array<{ name: string }>>`select current_database() as name`;
      check(/^ohb84_audit_policy_[a-f0-9]{32}$/.test(current[0]?.name ?? "") && current[0]?.name !== "ohb",
        "The generated disposable database name did not pass its safety check.");
      disposableDatabaseName = current[0]!.name;
      report.freshDatabaseNameValidated = true;

      const migrationRows = await owner<Array<{ count: number; applied: boolean }>>`
        select count(*)::int as count,
          exists(select 1 from schema_migrations where version = '0097_a2a_policy_denials') as applied
        from schema_migrations`;
      report.migrationsApplied = migrationRows[0]?.count ?? 0;
      report.migration0097Applied = migrationRows[0]?.applied === true;
      check(report.migrationsApplied >= 97 && report.migration0097Applied,
        "The disposable database did not receive the complete schema through migration 0097.");

      await owner`insert into users (id, email) values
        (${USER}, 'a2a-agency-operator@example.test'), (${CLIENT_OWNER}, 'a2a-client-owner@example.test')`;
      await owner`insert into organizations (id, slug, name, kind) values
        (${AGENCY}, 'a2a-policy-agency', 'A2A policy agency', 'agency'),
        (${CLIENT_A}, 'a2a-policy-client-a', 'A2A policy client A', 'personal'),
        (${CLIENT_B}, 'a2a-policy-client-b', 'A2A policy client B', 'personal'),
        (${CLIENT_DENIED}, 'a2a-policy-client-denied', 'A2A policy client denied', 'personal')`;
      await owner`insert into memberships (organization_id, user_id, role) values
        (${AGENCY}, ${USER}, 'owner'),
        (${CLIENT_A}, ${CLIENT_OWNER}, 'owner'),
        (${CLIENT_B}, ${CLIENT_OWNER}, 'owner'),
        (${CLIENT_DENIED}, ${CLIENT_OWNER}, 'owner')`;
      await owner`insert into agency_grants (id, agency_organization_id, client_organization_id, granted_by_user_id) values
        (${crypto.randomUUID()}, ${AGENCY}, ${CLIENT_A}, ${USER}),
        (${crypto.randomUUID()}, ${AGENCY}, ${CLIENT_B}, ${USER})`;
      for (const [runtimeId, organizationId] of [
        [RUNTIME_A, CLIENT_A], [RUNTIME_B, CLIENT_B], [RUNTIME_DENIED, CLIENT_DENIED],
      ]) {
        await owner`insert into runtimes
          (id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag, is_active)
          values (${runtimeId}, ${organizationId}, 'audit fixture', 'https://runtime.invalid', 'cipher', 'nonce', 'tag', true)`;
      }

      const api = await connect("ohb_api");
      const worker = await connect("ohb_worker");
      const scopeA: Scope = { userId: USER, agencyId: AGENCY, clientId: CLIENT_A };
      const scopeB: Scope = { userId: USER, agencyId: AGENCY, clientId: CLIENT_B };
      const deniedScope: Scope = { userId: USER, agencyId: AGENCY, clientId: CLIENT_DENIED };
      const sourceSnapshot = snapshot([
        upstream(0, SAME_TS),
        policyGuard(0, SAME_TS),
        policyProbe(1, SAME_TS - 1),
        upstream(90, SAME_TS, { taskId: undefined }),
        policyProbe(91, SAME_TS, { taskId: undefined }),
        policyProbe(92, SAME_TS, { id: "policy_denials:92" }),
      ], {
        summary: "DROP_A2A_TOP_LEVEL_SUMMARY_SENTINEL",
        bearer: "DROP_A2A_TOP_LEVEL_TOKEN_SENTINEL",
        organizationId: CLIENT_B,
        runtimeId: RUNTIME_B,
      });
      const first = await refreshAgencyA2AAudit(api, scopeA, RUNTIME_A, async (limit) => {
        check(limit === 10, "The host read limit changed unexpectedly.");
        return sourceSnapshot;
      }, { limit: 10 });
      check(first.insertedRecords === 3 && first.droppedRecords === 3,
        "The first real SQL projection did not insert three valid records and drop three invalid ones.");
      report.initialInserted = first.insertedRecords;
      report.invalidRecordsDropped = first.droppedRecords;

      const rows = await owner<Array<{ source: string; offset: string; taskId: string | null; peer: string }>>`
        select source, source_offset::text as offset, task_id as "taskId", peer
        from runtime_a2a_audit where organization_id = ${CLIENT_A} and runtime_id = ${RUNTIME_A}
        order by source, source_offset`;
      const upstreamRow = rows.find((row) => row.source === "a2a_audit" && row.offset === "0");
      const guardRow = rows.find((row) => row.source === "policy_denials" && row.offset === "0");
      const probeRow = rows.find((row) => row.source === "a2a_audit" && row.offset === "1");
      report.sameOffsetAcrossFiles = !!upstreamRow && !!guardRow;
      report.policyGuardTaskStoredNull = guardRow?.taskId === null;
      check(upstreamRow?.taskId === TASK_UPSTREAM && probeRow?.taskId === TASK_PROBE,
        "Upstream or probe task IDs were not required and projected.");
      report.upstreamAndProbeTasksRequired = true;
      check(rows.length === 3, "Invalid source identities or taskless upstream/probe records were inserted.");

      const repeated = await refreshAgencyA2AAudit(api, scopeA, RUNTIME_A, async () => sourceSnapshot, { limit: 10 });
      check(repeated.insertedRecords === 0 && repeated.duplicateRecords === 3,
        "The second import was not idempotent across both source files.");
      report.duplicateReimport = repeated.duplicateRecords;

      let collisionCode = "";
      try {
        await refreshAgencyA2AAudit(api, scopeA, RUNTIME_A, async () => snapshot([
          upstream(0, SAME_TS, { peer: "peer_changed" }),
        ]), { limit: 10 });
      } catch (error) {
        collisionCode = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      }
      report.changedPayloadCollisionRejected = collisionCode === "A2A_AUDIT_ID_COLLISION";
      check(report.changedPayloadCollisionRejected, "A changed payload reused a source/offset identity without conflict.");
      const original = await owner<Array<{ peer: string }>>`
        select peer from runtime_a2a_audit where organization_id = ${CLIENT_A} and runtime_id = ${RUNTIME_A}
          and source = 'a2a_audit' and source_offset = 0`;
      check(original[0]?.peer === "peer_upstream", "The collision overwrote the existing projected row.");

      const page1 = await readAgencyA2AAuditPage(api, scopeA, RUNTIME_A, { limit: 1 });
      const page2 = await readAgencyA2AAuditPage(api, scopeA, RUNTIME_A, { limit: 1, cursor: page1.nextCursor });
      const page3 = await readAgencyA2AAuditPage(api, scopeA, RUNTIME_A, { limit: 1, cursor: page2.nextCursor });
      report.crossFileCursorOrderStable = page1.records[0]?.id === "policy_denials:0"
        && page1.nextCursor === "policy_denials:0"
        && page2.records[0]?.id === "a2a_audit:0"
        && page2.nextCursor === "a2a_audit:0"
        && page3.records[0]?.id === "a2a_audit:1"
        && page3.nextCursor === null && !page3.hasMore;
      check(report.crossFileCursorOrderStable, "The cross-file cursor skipped or repeated an identity.");

      const projected = JSON.stringify({ first, repeated, page1, page2, page3 });
      const columns = await owner<Array<{ name: string }>>`
        select column_name as name from information_schema.columns where table_name = 'runtime_a2a_audit'`;
      const privateColumnsAbsent = !columns.some((column) => ["summary", "tokens", "raw_json", "request_args"].includes(column.name));
      report.unknownMetadataNotStoredOrProjected = privateColumnsAbsent
        && !projected.includes("DROP_A2A_PROMPT_SENTINEL")
        && !projected.includes("DROP_A2A_TOKEN_SENTINEL")
        && !projected.includes("DROP_GUARD_SUMMARY_SENTINEL")
        && !projected.includes("DROP_GUARD_TOKEN_SENTINEL")
        && !projected.includes("DROP_A2A_TOP_LEVEL_SUMMARY_SENTINEL")
        && !projected.includes("DROP_A2A_TOP_LEVEL_TOKEN_SENTINEL")
        && !projected.includes(CLIENT_B) && !projected.includes(RUNTIME_B);
      check(report.unknownMetadataNotStoredOrProjected,
        "Unknown host metadata, summary, token, or foreign scope data reached storage or projection.");

      const crossTenantRows = await withTenant(api, CLIENT_B, (tx) => tx<Array<{ count: number }>>`
        select count(*)::int as count from runtime_a2a_audit where organization_id = ${CLIENT_A}`);
      report.tenantRlsIsolation = crossTenantRows[0]?.count === 0;
      check(report.tenantRlsIsolation, "The actual API role crossed the tenant RLS boundary.");
      const otherClientPage: A2AAuditPageDto = await readAgencyA2AAuditPage(api, scopeB, RUNTIME_B, { limit: 10 });
      check(otherClientPage.totalRecords === 0 && otherClientPage.records.length === 0,
        "The second client's authorized runtime read returned the first client's rows.");

      let workerDenied = false;
      let workerQueryThrew = false;
      try {
        await withTenant(worker, CLIENT_A, (tx) => tx`select source_offset from runtime_a2a_audit limit 1`);
      } catch {
        workerQueryThrew = true;
      }
      const workerPrivilege = await owner<Array<{ allowed: boolean }>>`
        select has_table_privilege('ohb_worker', 'runtime_a2a_audit', 'select') as allowed`;
      workerDenied = workerQueryThrew && workerPrivilege[0]?.allowed === false;
      report.workerSelectDenied = workerDenied;
      check(workerDenied, "The worker role could read the A2A audit projection.");

      const invalidChecks = await Promise.all([
        expectCheckConstraint(owner, { source: "policy_denials", offset: 901, sourceKind: "operator.policy_probe", direction: "denied", peer: "peer_invalid", taskId: TASK_PROBE }),
        expectCheckConstraint(owner, { source: "a2a_audit", offset: 902, sourceKind: "upstream", direction: "inbound", peer: "peer_invalid", taskId: null }),
        expectCheckConstraint(owner, { source: "a2a_audit", offset: 903, sourceKind: "operator.policy_probe", direction: "denied", peer: "peer_invalid", taskId: null }),
        expectCheckConstraint(owner, { source: "policy_denials", offset: 904, sourceKind: "operator.policy_guard", direction: "outbound", peer: "peer_invalid", taskId: null }),
      ]);
      report.sqlCheckConstraintsRejectInvalidPairs = invalidChecks.every(Boolean);
      check(report.sqlCheckConstraintsRejectInvalidPairs,
        "Migration 0097 did not reject invalid source, source-kind, direction, or task combinations with CHECK violations.");

      let beforeHostCalls = 0;
      let readRevokedCode = "";
      try {
        await readAgencyA2AAuditPage(api, deniedScope, RUNTIME_DENIED, { limit: 10 });
      } catch (error) {
        readRevokedCode = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      }
      let importRevokedCode = "";
      try {
        await refreshAgencyA2AAudit(api, deniedScope, RUNTIME_DENIED, async () => {
          beforeHostCalls += 1;
          return snapshot([upstream(95, SAME_TS)]);
        }, { limit: 10 });
      } catch (error) {
        importRevokedCode = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      }
      report.revokedBeforeReadAndImport = readRevokedCode === "WORKSPACE_ACCESS_REVOKED"
        && importRevokedCode === "WORKSPACE_ACCESS_REVOKED" && beforeHostCalls === 0;
      check(report.revokedBeforeReadAndImport, "An absent exact mandate allowed audit read or host access.");

      let revokedA = 0;
      let successfulHostCalls = 0;
      let inflightCode = "";
      try {
        await refreshAgencyA2AAudit(api, scopeA, RUNTIME_A, async () => {
          successfulHostCalls += 1;
          const updated = await owner<Array<{ id: string }>>`update agency_grants set revoked_at = now()
            where agency_organization_id = ${AGENCY} and client_organization_id = ${CLIENT_A} and revoked_at is null
            returning id`;
          revokedA = updated.length;
          return snapshot([upstream(96, SAME_TS)]);
        }, { limit: 10 });
      } catch (error) {
        inflightCode = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      }
      const noInflightWriteA = await owner<Array<{ count: number }>>`
        select count(*)::int as count from runtime_a2a_audit
        where organization_id = ${CLIENT_A} and runtime_id = ${RUNTIME_A} and source_offset = 96`;
      report.inFlightRevocationPreventsImport = revokedA === 1 && successfulHostCalls === 1
        && inflightCode === "WORKSPACE_ACCESS_REVOKED" && noInflightWriteA[0]?.count === 0;
      check(report.inFlightRevocationPreventsImport, "A mandate revoked during collection still imported a row.");

      let failedHostCalls = 0;
      let failedDuringCode = "";
      try {
        await refreshAgencyA2AAudit(api, scopeB, RUNTIME_B, async () => {
          failedHostCalls += 1;
          await owner`update agency_grants set revoked_at = now()
            where agency_organization_id = ${AGENCY} and client_organization_id = ${CLIENT_B} and revoked_at is null`;
          throw new Error("DROP_PRIVATE_HOST_FAILURE_SENTINEL");
        }, { limit: 10 });
      } catch (error) {
        failedDuringCode = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      }
      const noInflightWriteB = await owner<Array<{ count: number }>>`
        select count(*)::int as count from runtime_a2a_audit
        where organization_id = ${CLIENT_B} and runtime_id = ${RUNTIME_B} and source_offset = 97`;
      report.inFlightFailureMaskedByRevocation = failedHostCalls === 1
        && failedDuringCode === "WORKSPACE_ACCESS_REVOKED" && noInflightWriteB[0]?.count === 0;
      check(report.inFlightFailureMaskedByRevocation,
        "A failing host read after mandate revocation exposed the host failure or wrote a row.");
    });
    report.databaseCreatedAndDropped = true;
    report.complete = true;
  } catch {
    failed = true;
    report.complete = false;
  } finally {
    if (disposableDatabaseName && process.env.INTEGRATION_ADMIN_DATABASE_URL) {
      const verifier = new SQL({ url: process.env.INTEGRATION_ADMIN_DATABASE_URL, max: 1 });
      try {
        const remains = await verifier<Array<{ present: boolean }>>`
          select exists(select 1 from pg_database where datname = ${disposableDatabaseName}) as present`;
        report.databaseCreatedAndDropped = remains[0]?.present === false;
      } catch {
        report.databaseCreatedAndDropped = false;
      } finally {
        await verifier.close().catch(() => undefined);
      }
    }
    if (previousAdminUrl === undefined) delete process.env.INTEGRATION_ADMIN_DATABASE_URL;
    else process.env.INTEGRATION_ADMIN_DATABASE_URL = previousAdminUrl;
    await Bun.write(REPORT_PATH, `${JSON.stringify(report)}\n`);
  }
  if (failed) throw new Error("The disposable A2A PostgreSQL acceptance proof failed; details were suppressed.");
}

await run();
// `run` throws on any failed check; reaching here means `complete: true`.
process.exitCode = report.complete === true ? 0 : 1;
