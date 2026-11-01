export type A2AAuditSnapshotStatus = "available" | "missing" | "truncated";

export type A2AAuditSourceKind = "upstream" | "operator.policy_probe" | "operator.policy_guard";

export type A2AAuditDirection = "inbound" | "outbound" | "push" | "denied";

/** Sanitized host record. Prompt, reply, token counts and unknown fields are excluded. */
export type A2AAuditHostRecord = {
  id: string;
  source: A2AAuditSourceKind;
  ts: number;
  direction: A2AAuditDirection;
  peer?: string;
  taskId?: string;
};

/** Bounded response from the named, read-only host audit endpoint. */
export type A2AAuditHostSnapshot = {
  status: A2AAuditSnapshotStatus;
  source: "a2a_audit";
  limit: number;
  truncated: boolean;
  skippedRecords?: number;
  records: A2AAuditHostRecord[];
};

export type A2AAuditRecordDto = {
  id: string;
  sourceKind: A2AAuditSourceKind;
  ts: number;
  direction: A2AAuditDirection;
  peer: string | null;
  taskId: string | null;
};

export type A2AAuditPageDto = {
  records: A2AAuditRecordDto[];
  totalRecords: number;
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
  observedAt: string;
};

/** Result of one explicit host refresh followed by an authorized database page read. */
export type A2AAuditRefreshDto = {
  status: A2AAuditSnapshotStatus;
  source: "a2a_audit";
  limit: number;
  truncated: boolean;
  receivedRecords: number;
  insertedRecords: number;
  duplicateRecords: number;
  droppedRecords: number;
  page: A2AAuditPageDto;
};
