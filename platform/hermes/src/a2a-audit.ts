import { HermesClientError } from "./errors";

export type A2AAuditHostSource = "upstream" | "operator.policy_probe" | "operator.policy_guard";
export type A2AAuditHostDirection = "inbound" | "outbound" | "push" | "denied";
export type A2AAuditHostStatus = "available" | "missing" | "truncated";

/** Local SDK shape mirrors the host DTO without adding a contracts-api dependency. */
export type A2AAuditHostRecord = {
  id: string;
  source: A2AAuditHostSource;
  ts: number;
  direction: A2AAuditHostDirection;
  peer?: string;
  taskId?: string;
};

/** Metadata-only projection returned by the fixed read-only host route. */
export type A2AAuditHostSnapshot = {
  status: A2AAuditHostStatus;
  source: "a2a_audit";
  limit: number;
  truncated: boolean;
  skippedRecords?: number;
  records: A2AAuditHostRecord[];
};

const MAX_A2A_AUDIT_RECORDS = 100;
const MAX_A2A_AUDIT_SKIPPED = 1_000_000;

function invalidAuditResponse(): HermesClientError {
  return new HermesClientError("La réponse de l'audit A2A est invalide.", 502, "HERMES_RESPONSE_INVALID");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > maximum
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw invalidAuditResponse();
  return value;
}

function finiteInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidAuditResponse();
  }
  return value;
}

/** Strictly validates the host envelope, then projects only safe audit metadata. */
export function parseA2AAuditHostSnapshot(value: unknown, requestedLimit?: number): A2AAuditHostSnapshot {
  const snapshot = objectRecord(value);
  if (!snapshot || typeof snapshot.status !== "string" || !["available", "missing", "truncated"].includes(snapshot.status)
    || snapshot.source !== "a2a_audit" || typeof snapshot.truncated !== "boolean" || !Array.isArray(snapshot.records)) {
    throw invalidAuditResponse();
  }
  const limit = finiteInteger(snapshot.limit, 1, MAX_A2A_AUDIT_RECORDS);
  if (requestedLimit !== undefined && limit !== requestedLimit) throw invalidAuditResponse();
  if (snapshot.records.length > limit || snapshot.records.length > MAX_A2A_AUDIT_RECORDS) throw invalidAuditResponse();
  if ((snapshot.status === "truncated") !== snapshot.truncated) throw invalidAuditResponse();
  if (snapshot.status === "missing" && (snapshot.records.length > 0 || snapshot.truncated)) throw invalidAuditResponse();

  let skippedRecords: number | undefined;
  if (snapshot.skippedRecords !== undefined) {
    skippedRecords = finiteInteger(snapshot.skippedRecords, 0, MAX_A2A_AUDIT_SKIPPED);
  }

  const records = snapshot.records.map((raw): A2AAuditHostRecord => {
    const record = objectRecord(raw);
    if (!record || (record.source !== "upstream" && record.source !== "operator.policy_probe" && record.source !== "operator.policy_guard")
      || (record.direction !== "inbound" && record.direction !== "outbound" && record.direction !== "push" && record.direction !== "denied")) {
      throw invalidAuditResponse();
    }
    const id = boundedText(record.id, 40);
    const idMatch = /^(a2a_audit|policy_denials):(0|[1-9][0-9]{0,18})$/.exec(id);
    if (!idMatch?.[1] || !idMatch[2] || BigInt(idMatch[2]) > 9_223_372_036_854_775_807n
      || typeof record.ts !== "number" || !Number.isFinite(record.ts) || record.ts <= 0 || record.ts >= 253_402_300_800
      || (record.source === "upstream" && (idMatch[1] !== "a2a_audit" || record.direction === "denied"))
      || (record.source === "operator.policy_probe" && (idMatch[1] !== "a2a_audit" || record.direction !== "denied"))
      || (record.source === "operator.policy_guard" && (idMatch[1] !== "policy_denials" || record.direction !== "denied"))) {
      throw invalidAuditResponse();
    }
    let taskId: string | undefined;
    if (record.taskId !== undefined) {
      taskId = boundedText(record.taskId, 64);
      if (!/^task-[a-f0-9]{16}$/.test(taskId)) throw invalidAuditResponse();
    }
    if (record.source !== "operator.policy_guard" && taskId === undefined) throw invalidAuditResponse();
    const projected: A2AAuditHostRecord = {
      id,
      source: record.source,
      ts: record.ts,
      direction: record.direction,
    };
    if (record.peer !== undefined) projected.peer = boundedText(record.peer, 128);
    if (taskId !== undefined) projected.taskId = taskId;
    return projected;
  });

  return {
    status: snapshot.status as A2AAuditHostStatus,
    source: "a2a_audit",
    limit,
    truncated: snapshot.truncated,
    ...(skippedRecords === undefined ? {} : { skippedRecords }),
    records,
  };
}
