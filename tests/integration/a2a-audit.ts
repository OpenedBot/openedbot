import { withTenant } from "../../platform/db/src/db";
import {
  readAgencyA2AAuditPage,
  refreshAgencyA2AAudit,
} from "../../modules/runtimes/src/application/a2a-audit";
import { withDisposablePostgres } from "./disposable-postgres";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function snapshot(records: unknown[], overrides: Record<string, unknown> = {}) {
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

function upstream(offset: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `a2a_audit:${offset}`,
    source: "upstream",
    ts: 1_760_000_000 + offset,
    direction: "inbound",
    peer: "peer_alpha",
    taskId: "task-0123456789abcdef",
    ...overrides,
  };
}

function policyProbe(offset: number) {
  return {
    id: `a2a_audit:${offset}`,
    source: "operator.policy_probe",
    ts: 1_760_000_000 + offset,
    direction: "denied",
    peer: "peer_alpha",
    taskId: "task-0123456789abcdef",
    summary: "",
  };
}

await withDisposablePostgres("ohb81_a2a_audit", async ({ owner, connect }) => {
  const user = "81000000-0000-4000-8000-000000000001";
  const clientOwner = "81000000-0000-4000-8000-000000000002";
  const agency = "81000000-0000-4000-8000-000000000003";
  const clientA = "81000000-0000-4000-8000-000000000004";
  const clientB = "81000000-0000-4000-8000-000000000005";
  const deniedClient = "81000000-0000-4000-8000-000000000006";
  const runtimeA = "81000000-0000-4000-8000-000000000010";
  const runtimeB = "81000000-0000-4000-8000-000000000011";
  const deniedRuntime = "81000000-0000-4000-8000-000000000012";

  await owner`insert into users (id, email) values
    (${user}, 'a2a-operator@example.test'), (${clientOwner}, 'a2a-owner@example.test')`;
  await owner`insert into organizations (id, slug, name, kind) values
    (${agency}, 'a2a-agency', 'A2A agency', 'agency'),
    (${clientA}, 'a2a-client-a', 'A2A client A', 'personal'),
    (${clientB}, 'a2a-client-b', 'A2A client B', 'personal'),
    (${deniedClient}, 'a2a-client-denied', 'A2A client denied', 'personal')`;
  await owner`insert into memberships (organization_id, user_id, role) values
    (${agency}, ${user}, 'owner'),
    (${clientA}, ${clientOwner}, 'owner'),
    (${clientB}, ${clientOwner}, 'owner'),
    (${deniedClient}, ${clientOwner}, 'owner')`;
  await owner`insert into agency_grants (id, agency_organization_id, client_organization_id, granted_by_user_id) values
    (${crypto.randomUUID()}, ${agency}, ${clientA}, ${user}),
    (${crypto.randomUUID()}, ${agency}, ${clientB}, ${user})`;
  for (const [runtimeId, organizationId] of [[runtimeA, clientA], [runtimeB, clientB], [deniedRuntime, deniedClient]]) {
    await owner`insert into runtimes (id, organization_id, name, endpoint, token_ciphertext, token_nonce, token_tag)
      values (${runtimeId}, ${organizationId}, 'fixture runtime', 'http://127.0.0.1:8123', 'cipher', 'nonce', 'tag')`;
  }

  const api = await connect("ohb_api");
  const worker = await connect("ohb_worker");
  const scopeA = { userId: user, agencyId: agency, clientId: clientA };
  const scopeB = { userId: user, agencyId: agency, clientId: clientB };
  const firstSnapshot = snapshot([upstream(100, {
    summary: "DROP_A2A_PROMPT_OR_REPLY",
    tokens: { secret: "DROP_A2A_TOKEN_FIELD" },
    organizationId: clientB,
    runtimeId: runtimeB,
  }), policyProbe(150)], {
    organizationId: clientB,
    runtimeId: runtimeB,
    secretUnknown: "DROP_A2A_TOP_LEVEL_UNKNOWN",
  });
  const first = await refreshAgencyA2AAudit(api, scopeA, runtimeA, async (limit) => {
    check(limit === 10, "The requested host audit bound changed");
    return firstSnapshot;
  }, { limit: 10 });
  check(first.insertedRecords === 2 && first.duplicateRecords === 0 && first.page.totalRecords === 2,
    "The first refresh did not project the two sanitized records");
  check(first.page.records.some((record) => record.sourceKind === "operator.policy_probe" && record.direction === "denied"),
    "The host policy-probe receipt lost its source kind");
  const serialized = JSON.stringify(first);
  for (const forbidden of ["DROP_A2A_PROMPT_OR_REPLY", "DROP_A2A_TOKEN_FIELD", "DROP_A2A_TOP_LEVEL_UNKNOWN", "summary", "tokens", clientB, runtimeB]) {
    check(!serialized.includes(forbidden), "Private or host-supplied scope data escaped the projection");
  }
  const columns = await owner<Array<{ columnName: string }>>`
    select column_name as "columnName" from information_schema.columns
    where table_name = 'runtime_a2a_audit'`;
  check(!columns.some((column) => column.columnName === "summary" || column.columnName === "tokens"),
    "Raw summary or token columns were added to the cloud schema");
  let workerBlocked = false;
  try {
    await withTenant(worker, clientA, (tx) => tx`select source_offset from runtime_a2a_audit limit 1`);
  } catch {
    workerBlocked = true;
  }
  check(workerBlocked, "The worker role received unnecessary A2A audit privileges");

  const repeated = await refreshAgencyA2AAudit(api, scopeA, runtimeA, async () => firstSnapshot, { limit: 10 });
  check(repeated.insertedRecords === 0 && repeated.duplicateRecords === 2 && repeated.page.totalRecords === 2,
    "A repeated offset did not project idempotently");

  const collision = snapshot([upstream(100, { peer: "peer_changed" })]);
  let collisionCode = "";
  try {
    await refreshAgencyA2AAudit(api, scopeA, runtimeA, async () => collision, { limit: 10 });
  } catch (error) {
    collisionCode = String((error as { code?: string }).code ?? "");
  }
  check(collisionCode === "A2A_AUDIT_ID_COLLISION", "A changed payload reused its old offset without a collision error");
  const original = await owner<Array<{ peer: string }>>`
    select peer from runtime_a2a_audit where organization_id = ${clientA} and runtime_id = ${runtimeA}
      and source_offset = 100`;
  check(original[0]?.peer === "peer_alpha", "An offset collision silently overwrote prior metadata");

  const mixedSnapshot = snapshot([
    upstream(200, { summary: "DROP_SECOND_PROMPT" }),
    upstream(201, { source: "unknown-origin" }),
    upstream(202, { ts: "not-a-number" }),
  ], { skippedRecords: 1 });
  const mixed = await refreshAgencyA2AAudit(api, scopeA, runtimeA, async () => mixedSnapshot, { limit: 10 });
  check(mixed.insertedRecords === 1 && mixed.droppedRecords === 3 && mixed.page.totalRecords === 3,
    "Malformed and unknown-origin records were not dropped and counted");
  check(!JSON.stringify(mixed).includes("DROP_SECOND_PROMPT"), "A later raw summary was returned by the page");

  const newest = await readAgencyA2AAuditPage(api, scopeA, runtimeA, { limit: 2 });
  check(newest.records.map((record) => record.id).join(",") === "a2a_audit:200,a2a_audit:150" &&
    newest.totalRecords === 3 && newest.hasMore && newest.nextCursor === "a2a_audit:150",
  "The first audit page did not use stable descending offset pagination");
  const older = await readAgencyA2AAuditPage(api, scopeA, runtimeA, { limit: 2, cursor: newest.nextCursor });
  check(older.records.length === 1 && older.records[0]?.id === "a2a_audit:100" && !older.hasMore && older.nextCursor === null,
    "The audit cursor duplicated or skipped an older record");

  const missing = await refreshAgencyA2AAudit(api, scopeA, runtimeA, async () => snapshot([], {
    status: "missing", truncated: false,
  }), { limit: 10 });
  check(missing.status === "missing" && missing.receivedRecords === 0 && missing.page.totalRecords === 3,
    "A missing host log was not distinguished from its retained cloud page");

  const clientBResult = await refreshAgencyA2AAudit(api, scopeB, runtimeB, async () => snapshot([upstream(50)]), { limit: 10 });
  check(clientBResult.insertedRecords === 1 && clientBResult.page.totalRecords === 1,
    "A second authorized tenant could not project its own runtime audit");
  const crossTenant = await withTenant(api, clientB, (tx) => tx<Array<{ count: number }>>`
    select count(*)::int as count from runtime_a2a_audit where organization_id = ${clientA}`);
  check(crossTenant[0]?.count === 0, "RLS exposed client A audit rows inside client B");
  let crossRuntimeCode = "";
  try {
    await readAgencyA2AAuditPage(api, scopeB, runtimeA, { limit: 10 });
  } catch (error) {
    crossRuntimeCode = String((error as { code?: string }).code ?? "");
  }
  check(crossRuntimeCode === "RUNTIME_NOT_FOUND", "A client could read another tenant runtime by UUID");

  let deniedNetworkCalls = 0;
  let deniedCode = "";
  try {
    await refreshAgencyA2AAudit(api, { ...scopeA, clientId: deniedClient }, deniedRuntime, async () => {
      deniedNetworkCalls += 1;
      return snapshot([upstream(75)]);
    }, { limit: 10 });
  } catch (error) {
    deniedCode = String((error as { code?: string }).code ?? "");
  }
  check(deniedCode === "WORKSPACE_ACCESS_REVOKED" && deniedNetworkCalls === 0,
    "An unmandated client reached the host reader");

  await owner`delete from runtimes where organization_id = ${clientB} and id = ${runtimeB}`;
  const cascaded = await owner<Array<{ count: number }>>`
    select count(*)::int as count from runtime_a2a_audit where organization_id = ${clientB} and runtime_id = ${runtimeB}`;
  check(cascaded[0]?.count === 0, "Deleting a runtime did not cascade its audit metadata");

  let revokedCode = "";
  try {
    await refreshAgencyA2AAudit(api, scopeA, runtimeA, async () => {
      await owner`update agency_grants set revoked_at = now()
        where agency_organization_id = ${agency} and client_organization_id = ${clientA} and revoked_at is null`;
      return snapshot([upstream(300)]);
    }, { limit: 10 });
  } catch (error) {
    revokedCode = String((error as { code?: string }).code ?? "");
  }
  check(revokedCode === "WORKSPACE_ACCESS_REVOKED", "A mandate revoked during host collection was returned");
  const revokedWrite = await owner<Array<{ count: number }>>`
    select count(*)::int as count from runtime_a2a_audit
    where organization_id = ${clientA} and runtime_id = ${runtimeA} and source_offset = 300`;
  check(revokedWrite[0]?.count === 0, "A mandate revoked during host collection still wrote cloud audit rows");

  console.log(JSON.stringify({
    database: "disposable",
    role: "ohb_api",
    inserted: first.insertedRecords + mixed.insertedRecords + clientBResult.insertedRecords,
    duplicates: repeated.duplicateRecords,
    dropped: mixed.droppedRecords,
    collisionRejected: collisionCode === "A2A_AUDIT_ID_COLLISION",
    hostScopeIgnored: first.page.totalRecords === 2 && first.page.records.some((record) => record.id === "a2a_audit:100"),
    tenantRls: crossTenant[0]?.count === 0,
    workerRoleBlocked: workerBlocked,
    mandateRevokedBeforeWrite: revokedCode === "WORKSPACE_ACCESS_REVOKED" && revokedWrite[0]?.count === 0,
    runtimeCascade: cascaded[0]?.count === 0,
  }));
});
