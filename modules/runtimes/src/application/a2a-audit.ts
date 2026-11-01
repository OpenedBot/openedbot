import { asRecord, isStrictUuid } from "@openedbot/contracts-primitives";
import type {
  A2AAuditDirection,
  A2AAuditPageDto,
  A2AAuditRecordDto,
  A2AAuditRefreshDto,
  A2AAuditSnapshotStatus,
  A2AAuditSourceKind,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertClientMandate } from "./fleet";

const auditSource = "a2a_audit" as const;
const policyDenialSource = "policy_denials" as const;
type A2AAuditSourceFile = typeof auditSource | typeof policyDenialSource;
const defaultAuditLimit = 50;
const maxAuditLimit = 100;
const maxAuditSkipped = 1_000_000_000;
const maxAuditUnixSeconds = 253_402_300_799;
const maxPostgresBigint = 9_223_372_036_854_775_807n;
const auditIDPattern = /^(a2a_audit|policy_denials):(0|[1-9][0-9]{0,18})$/;
const peerPattern = /^[A-Za-z0-9][A-Za-z0-9._:@_-]{0,127}$/;
const taskIDPattern = /^task-[a-f0-9]{16}$/;

export type A2AAuditScope = { userId: string; agencyId: string; clientId: string };
export type A2AAuditHostReader = (limit: number) => Promise<unknown>;
export type A2AAuditPageRequest = { limit?: number; cursor?: string | null };

export type ParsedA2AAuditRecord = {
  id: string;
  sourceFile: A2AAuditSourceFile;
  sourceOffset: string;
  sourceKind: A2AAuditSourceKind;
  ts: number;
  direction: A2AAuditDirection;
  peer: string;
  taskId: string | null;
};

export type ParsedA2AAuditSnapshot = {
  status: A2AAuditSnapshotStatus;
  source: typeof auditSource;
  limit: number;
  truncated: boolean;
  receivedRecords: number;
  droppedRecords: number;
  records: ParsedA2AAuditRecord[];
};

type AuditInsertCounts = { inserted: number; duplicates: number };

/** Parse an untrusted host response into the allowlisted A2A audit metadata. */
export function parseA2AAuditSnapshot(input: unknown, requestedLimit: number): ParsedA2AAuditSnapshot {
  requireAuditLimit(requestedLimit);
  const snapshot = asRecord(input);
  if (!snapshot || snapshot.source !== auditSource || snapshot.limit !== requestedLimit ||
    !isAuditStatus(snapshot.status) || typeof snapshot.truncated !== "boolean" || !Array.isArray(snapshot.records)) {
    throw invalidAuditSnapshot();
  }
  if ((snapshot.status === "truncated") !== snapshot.truncated ||
    (snapshot.status === "missing" && snapshot.records.length !== 0)) {
    throw invalidAuditSnapshot();
  }

  const skippedRecords = snapshot.skippedRecords === undefined ? 0 : snapshot.skippedRecords;
  if (typeof skippedRecords !== "number" || !Number.isSafeInteger(skippedRecords) || skippedRecords < 0 || skippedRecords > maxAuditSkipped) {
    throw invalidAuditSnapshot();
  }

  const receivedRecords = snapshot.records.length;
  const boundedRecords = snapshot.records.slice(-requestedLimit);
  let droppedRecords = skippedRecords + Math.max(0, receivedRecords - boundedRecords.length);
  const records: ParsedA2AAuditRecord[] = [];
  for (const raw of boundedRecords) {
    const record = parseA2AAuditRecord(raw);
    if (!record) {
      droppedRecords += 1;
      continue;
    }
    records.push(record);
  }

  return {
    status: snapshot.status,
    source: auditSource,
    limit: requestedLimit,
    truncated: snapshot.truncated,
    receivedRecords,
    droppedRecords,
    records,
  };
}

/** Pulls the host outside a SQL transaction, then rechecks the exact mandate before projection and return. */
export async function refreshAgencyA2AAudit(
  db: Db,
  scope: A2AAuditScope,
  runtimeId: string,
  readHost: A2AAuditHostReader,
  request: A2AAuditPageRequest = {},
): Promise<A2AAuditRefreshDto> {
  const limit = request.limit ?? defaultAuditLimit;
  requireAuditScope(scope, runtimeId);
  requireAuditLimit(limit);
  const cursor = parseAuditCursor(request.cursor);

  await withTenant(db, scope.clientId, (tx) => authorizeAuditRuntime(tx, scope, runtimeId));
  let payload: unknown;
  let readFailed = false;
  try {
    payload = await readHost(limit);
  } catch {
    readFailed = true;
  }
  // Revalidate after network completion, including failures, before exposing a result.
  await withTenant(db, scope.clientId, (tx) => authorizeAuditRuntime(tx, scope, runtimeId));
  if (readFailed) {
    throw new HttpError(502, "A2A_AUDIT_UNAVAILABLE", "The runtime A2A audit could not be read.");
  }
  let snapshot: ParsedA2AAuditSnapshot;
  try {
    snapshot = parseA2AAuditSnapshot(payload, limit);
  } catch (error) {
    await withTenant(db, scope.clientId, (tx) => authorizeAuditRuntime(tx, scope, runtimeId));
    throw error;
  }

  return withTenant(db, scope.clientId, async (tx) => {
    await authorizeAuditRuntime(tx, scope, runtimeId);
    await assertClientMandate(tx, scope.userId, scope.clientId, scope.agencyId);
    const counts = await projectAuditRecords(tx, scope.clientId, runtimeId, snapshot.records);
    const page = await readAuditPage(tx, scope, runtimeId, { limit, cursor });
    await assertClientMandate(tx, scope.userId, scope.clientId, scope.agencyId);
    return {
      status: snapshot.status,
      source: auditSource,
      limit,
      truncated: snapshot.truncated,
      receivedRecords: snapshot.receivedRecords,
      insertedRecords: counts.inserted,
      duplicateRecords: counts.duplicates,
      droppedRecords: snapshot.droppedRecords,
      page,
    };
  });
}

/** Reads already projected records with an exact mandate check before and after the page query. */
export async function readAgencyA2AAuditPage(
  db: Db,
  scope: A2AAuditScope,
  runtimeId: string,
  request: A2AAuditPageRequest = {},
): Promise<A2AAuditPageDto> {
  requireAuditScope(scope, runtimeId);
  const limit = request.limit ?? defaultAuditLimit;
  requireAuditLimit(limit);
  const cursor = parseAuditCursor(request.cursor);
  return withTenant(db, scope.clientId, (tx) => readAuditPage(tx, scope, runtimeId, { limit, cursor }));
}

function parseA2AAuditRecord(input: unknown): ParsedA2AAuditRecord | null {
  const record = asRecord(input);
  if (!record || typeof record.id !== "string" || typeof record.source !== "string" ||
    typeof record.ts !== "number" || !Number.isFinite(record.ts) || record.ts <= 0 ||
    record.ts > maxAuditUnixSeconds || typeof record.direction !== "string" ||
    typeof record.peer !== "string" || !peerPattern.test(record.peer)) {
    return null;
  }
  const sourceCursor = parseAuditID(record.id);
  if (!sourceCursor) return null;

  let sourceKind: A2AAuditSourceKind;
  let taskId: string | null = null;
  if (record.source === "upstream" && ["inbound", "outbound", "push"].includes(record.direction)) {
    if (sourceCursor.sourceFile !== auditSource || typeof record.taskId !== "string" || !taskIDPattern.test(record.taskId)) return null;
    taskId = record.taskId;
    sourceKind = "upstream";
  } else if (record.source === "operator.policy_probe" && record.direction === "denied") {
    if (sourceCursor.sourceFile !== auditSource || typeof record.taskId !== "string" || !taskIDPattern.test(record.taskId)) return null;
    if (record.summary !== undefined && record.summary !== "") return null;
    taskId = record.taskId;
    sourceKind = "operator.policy_probe";
  } else if (record.source === "operator.policy_guard" && record.direction === "denied") {
    if (sourceCursor.sourceFile !== policyDenialSource) return null;
    if (record.taskId !== undefined) {
      if (typeof record.taskId !== "string" || !taskIDPattern.test(record.taskId)) return null;
      taskId = record.taskId;
    }
    sourceKind = "operator.policy_guard";
  } else {
    return null;
  }

  return {
    id: `${sourceCursor.sourceFile}:${sourceCursor.sourceOffset}`,
    sourceFile: sourceCursor.sourceFile,
    sourceOffset: sourceCursor.sourceOffset,
    sourceKind,
    ts: record.ts,
    direction: record.direction as A2AAuditDirection,
    peer: record.peer,
    taskId,
  };
}

function parseAuditID(id: string): { sourceFile: A2AAuditSourceFile; sourceOffset: string } | null {
  const match = auditIDPattern.exec(id);
  if (!match?.[1] || !match[2]) return null;
  try {
    const offset = BigInt(match[2]);
    return offset <= maxPostgresBigint
      ? { sourceFile: match[1] as A2AAuditSourceFile, sourceOffset: offset.toString() }
      : null;
  } catch {
    return null;
  }
}

async function projectAuditRecords(
  tx: TransactionDb,
  clientId: string,
  runtimeId: string,
  records: ParsedA2AAuditRecord[],
): Promise<AuditInsertCounts> {
  let inserted = 0;
  let duplicates = 0;
  for (const record of records) {
    const created = await tx<Array<{ sourceOffset: string }>>`
      insert into runtime_a2a_audit (
        organization_id, runtime_id, source, source_offset, source_kind, ts, direction, peer, task_id
      ) values (
        ${clientId}::uuid, ${runtimeId}::uuid, ${record.sourceFile}, ${record.sourceOffset}::bigint,
        ${record.sourceKind}, ${record.ts}::double precision, ${record.direction}, ${record.peer}, ${record.taskId}
      ) on conflict (organization_id, runtime_id, source, source_offset) do nothing
      returning source_offset::text as "sourceOffset"`;
    if (created.length > 0) {
      inserted += 1;
      continue;
    }

    const same = await tx<Array<{ present: boolean }>>`
      select exists (
        select 1 from runtime_a2a_audit
        where organization_id = ${clientId}::uuid and runtime_id = ${runtimeId}::uuid
          and source = ${record.sourceFile} and source_offset = ${record.sourceOffset}::bigint
          and source_kind = ${record.sourceKind} and ts is not distinct from ${record.ts}::double precision
          and direction = ${record.direction} and peer is not distinct from ${record.peer}
          and task_id is not distinct from ${record.taskId}
      ) as present`;
    if (!same[0]?.present) {
      throw new HttpError(409, "A2A_AUDIT_ID_COLLISION", "A runtime reused an A2A audit offset with different metadata.");
    }
    duplicates += 1;
  }
  return { inserted, duplicates };
}

async function readAuditPage(
  tx: TransactionDb,
  scope: A2AAuditScope,
  runtimeId: string,
  request: { limit: number; cursor: { sourceFile: A2AAuditSourceFile; sourceOffset: string } | null },
): Promise<A2AAuditPageDto> {
  await authorizeAuditRuntime(tx, scope, runtimeId);
  let cursorTimestamp: number | null = null;
  if (request.cursor !== null) {
    const cursorRows = await tx<Array<{ ts: number }>>`
      select ts from runtime_a2a_audit
      where organization_id = ${scope.clientId}::uuid and runtime_id = ${runtimeId}::uuid
        and source = ${request.cursor.sourceFile} and source_offset = ${request.cursor.sourceOffset}::bigint`;
    if (!cursorRows[0]) {
      throw new HttpError(400, "A2A_AUDIT_CURSOR_INVALID", "The A2A audit cursor is invalid.");
    }
    cursorTimestamp = Number(cursorRows[0].ts);
  }
  const pageRows = request.cursor === null
    ? await tx<Array<AuditDbRecord>>`
      select (source || ':' || source_offset::text) as id, source as "sourceFile",
        source_kind as "sourceKind", ts, direction, peer, task_id as "taskId",
        source_offset::text as "sourceOffset"
      from runtime_a2a_audit where organization_id = ${scope.clientId}::uuid and runtime_id = ${runtimeId}::uuid
        and source in (${auditSource}, ${policyDenialSource})
      order by ts desc, source desc, source_offset desc limit ${request.limit + 1}`
    : await tx<Array<AuditDbRecord>>`
      select (source || ':' || source_offset::text) as id, source as "sourceFile",
        source_kind as "sourceKind", ts, direction, peer, task_id as "taskId",
        source_offset::text as "sourceOffset"
      from runtime_a2a_audit where organization_id = ${scope.clientId}::uuid and runtime_id = ${runtimeId}::uuid
        and source in (${auditSource}, ${policyDenialSource})
        and (ts, source, source_offset) < (${cursorTimestamp!}::double precision,
          ${request.cursor.sourceFile}, ${request.cursor.sourceOffset}::bigint)
      order by ts desc, source desc, source_offset desc limit ${request.limit + 1}`;
  const countRows = await tx<Array<{ total: string }>>`
    select count(*)::text as total from runtime_a2a_audit
    where organization_id = ${scope.clientId}::uuid and runtime_id = ${runtimeId}::uuid
      and source in (${auditSource}, ${policyDenialSource})`;
  const totalRecords = Number(countRows[0]?.total ?? 0);
  if (!Number.isSafeInteger(totalRecords) || totalRecords < 0) {
    throw new HttpError(503, "A2A_AUDIT_UNAVAILABLE", "The runtime A2A audit page could not be read.");
  }
  const hasMore = pageRows.length > request.limit;
  const selected = pageRows.slice(0, request.limit);
  const records: A2AAuditRecordDto[] = selected.map((row) => ({
    id: row.id,
    sourceKind: row.sourceKind,
    ts: Number(row.ts),
    direction: row.direction,
    peer: row.peer,
    taskId: row.taskId,
  }));
  const last = records.at(-1);
  const page: A2AAuditPageDto = {
    records,
    totalRecords,
    limit: request.limit,
    nextCursor: hasMore && last ? last.id : null,
    hasMore,
    observedAt: new Date().toISOString(),
  };
  await authorizeAuditRuntime(tx, scope, runtimeId);
  return page;
}

type AuditDbRecord = {
  id: string;
  sourceFile: A2AAuditSourceFile;
  sourceKind: A2AAuditSourceKind;
  ts: number;
  direction: A2AAuditDirection;
  peer: string;
  taskId: string | null;
  sourceOffset: string;
};

async function authorizeAuditRuntime(tx: TransactionDb, scope: A2AAuditScope, runtimeId: string): Promise<void> {
  await assertClientMandate(tx, scope.userId, scope.clientId, scope.agencyId);
  const rows = await tx<Array<{ id: string }>>`
    select id from runtimes where organization_id = ${scope.clientId}::uuid and id = ${runtimeId}::uuid`;
  if (!rows[0]) throw new HttpError(404, "RUNTIME_NOT_FOUND", "The runtime was not found in this client workspace.");
  await assertClientMandate(tx, scope.userId, scope.clientId, scope.agencyId);
}

function requireAuditScope(scope: A2AAuditScope, runtimeId: string): void {
  if (!isStrictUuid(scope.userId) || !isStrictUuid(scope.agencyId) || !isStrictUuid(scope.clientId) || !isStrictUuid(runtimeId)) {
    throw new HttpError(400, "A2A_AUDIT_INPUT_INVALID", "The A2A audit scope is invalid.");
  }
}

function requireAuditLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxAuditLimit) {
    throw new HttpError(400, "A2A_AUDIT_INPUT_INVALID", "The A2A audit page limit is invalid.");
  }
}

function parseAuditCursor(cursor: string | null | undefined): { sourceFile: A2AAuditSourceFile; sourceOffset: string } | null {
  if (cursor === undefined || cursor === null) return null;
  const parsed = parseAuditID(cursor);
  if (parsed === null) throw new HttpError(400, "A2A_AUDIT_CURSOR_INVALID", "The A2A audit cursor is invalid.");
  return parsed;
}

function isAuditStatus(value: unknown): value is A2AAuditSnapshotStatus {
  return value === "available" || value === "missing" || value === "truncated";
}

function invalidAuditSnapshot(): HttpError {
  return new HttpError(502, "A2A_AUDIT_INVALID", "The runtime returned an invalid A2A audit snapshot.");
}
