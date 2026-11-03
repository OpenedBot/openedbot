import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { Db } from "@openedbot/platform-db";
import { parseA2AAuditSnapshot, readAgencyA2AAuditPage, refreshAgencyA2AAudit, type A2AAuditScope } from "../src/application/a2a-audit";

const taskId = "task-0123456789abcdef";

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

function upstream(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: "upstream",
    ts: 1_760_000_000.125,
    direction: "inbound",
    peer: "peer_one",
    taskId,
    ...overrides,
  };
}

describe("A2A audit host response parser", () => {
  test("projects allowlisted metadata and discards private or unknown fields", () => {
    const input = snapshot([upstream("a2a_audit:123", {
      summary: "DROP_PROMPT_OR_REPLY",
      tokens: { secret: 123 },
      unknownField: "DROP_UNKNOWN_FIELD",
      organizationId: "99999999-9999-4999-8999-999999999999",
      runtimeId: "88888888-8888-4888-8888-888888888888",
    })], {
      summary: "DROP_TOP_LEVEL_SUMMARY",
      organizationId: "77777777-7777-4777-8777-777777777777",
      runtimeId: "66666666-6666-4666-8666-666666666666",
    });
    const parsed = parseA2AAuditSnapshot(input, 10);
    expect(parsed.records).toEqual([{
      id: "a2a_audit:123",
      sourceFile: "a2a_audit",
      sourceOffset: "123",
      sourceKind: "upstream",
      ts: 1_760_000_000.125,
      direction: "inbound",
      peer: "peer_one",
      taskId,
    }]);
    const serialized = JSON.stringify(parsed);
    for (const omitted of ["DROP_PROMPT_OR_REPLY", "DROP_TOP_LEVEL_SUMMARY", "DROP_UNKNOWN_FIELD", "tokens", "organizationId", "runtimeId"]) {
      expect(serialized).not.toContain(omitted);
    }
  });

  test("drops invalid metadata and unknown origins while reporting dropped counts", () => {
    const parsed = parseA2AAuditSnapshot(snapshot([
      upstream("a2a_audit:1"),
      upstream("a2a_audit:2", { source: "unknown-origin" }),
      upstream("a2a_audit:3", { direction: "denied" }),
      upstream("a2a_audit:4", { peer: "peer with spaces" }),
      { ...upstream("a2a_audit:5"), taskId: "unbounded task contents" },
    ], { skippedRecords: 2 }), 10);
    expect(parsed.records.map((record) => record.id)).toEqual(["a2a_audit:1"]);
    expect(parsed.receivedRecords).toBe(5);
    expect(parsed.droppedRecords).toBe(6);
  });

  test("accepts only the named host denial receipt shape", () => {
    const good = {
      id: "a2a_audit:500", source: "operator.policy_probe", ts: 1_760_000_001,
      direction: "denied", peer: "ip:127.0.0.1", taskId,
      summary: "",
    };
    const parsed = parseA2AAuditSnapshot(snapshot([
      good,
      { ...good, id: "a2a_audit:501", summary: "DROP_FORGED_RECEIPT" },
      { ...good, id: "a2a_audit:502", direction: "inbound" },
    ]), 10);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.sourceKind).toBe("operator.policy_probe");
    expect(parsed.records[0]?.direction).toBe("denied");
    expect(JSON.stringify(parsed)).not.toContain("DROP_FORGED_RECEIPT");
    expect(parsed.droppedRecords).toBe(2);
  });

  test("accepts metadata-only policy guard receipts from their own file with optional generated task IDs", () => {
    const withoutTask = {
      id: "policy_denials:500",
      source: "operator.policy_guard",
      ts: 1_760_000_002,
      direction: "denied",
      peer: "alpha",
      status: "blocked",
      summary: "DROP_SUMMARY",
      token: "DROP_TOKEN",
      unknown: "DROP_UNKNOWN",
    };
    const parsed = parseA2AAuditSnapshot(snapshot([
      withoutTask,
      { ...withoutTask, id: "policy_denials:501", taskId },
    ]), 10);
    expect(parsed.records).toEqual([
      {
        id: "policy_denials:500", sourceFile: "policy_denials", sourceOffset: "500",
        sourceKind: "operator.policy_guard", ts: 1_760_000_002, direction: "denied", peer: "alpha", taskId: null,
      },
      {
        id: "policy_denials:501", sourceFile: "policy_denials", sourceOffset: "501",
        sourceKind: "operator.policy_guard", ts: 1_760_000_002, direction: "denied", peer: "alpha", taskId,
      },
    ]);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/DROP_SUMMARY|DROP_TOKEN|DROP_UNKNOWN/);
    expect("status" in (parsed.records[0] ?? {})).toBe(false);
  });

  test("requires audit source-file, source-kind, direction, and task ID coherence", () => {
    const guard = {
      id: "policy_denials:7", source: "operator.policy_guard", ts: 1_760_000_003,
      direction: "denied", peer: "alpha",
    };
    const probe = {
      id: "a2a_audit:7", source: "operator.policy_probe", ts: 1_760_000_003,
      direction: "denied", peer: "alpha", taskId,
    };
    const parsed = parseA2AAuditSnapshot(snapshot([
      guard,
      probe,
      { ...guard, id: "a2a_audit:8" },
      { ...guard, direction: "inbound" },
      { ...guard, taskId: "caller supplied value" },
      { ...probe, id: "policy_denials:9" },
      { ...probe, taskId: undefined },
    ]), 10);
    expect(parsed.records.map((record) => record.id)).toEqual(["policy_denials:7", "a2a_audit:7"]);
    expect(parsed.records[0]?.taskId).toBeNull();
    expect(parsed.droppedRecords).toBe(5);
  });

  test("keeps same numeric offset distinct across the two fixed source files", () => {
    const guard = {
      id: "policy_denials:10", source: "operator.policy_guard", ts: 1_760_000_004,
      direction: "denied", peer: "alpha",
    };
    const original = upstream("a2a_audit:10");
    const parsed = parseA2AAuditSnapshot(snapshot([original, guard]), 10);
    expect(parsed.records.map((record) => [record.id, record.sourceFile])).toEqual([
      ["a2a_audit:10", "a2a_audit"],
      ["policy_denials:10", "policy_denials"],
    ]);
  });

  test("bounds returned records and preserves the newest tail order", () => {
    const records = Array.from({ length: 12 }, (_, index) => upstream(`a2a_audit:${index}`));
    const parsed = parseA2AAuditSnapshot(snapshot(records), 10);
    expect(parsed.records.map((record) => record.sourceOffset)).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    expect(parsed.droppedRecords).toBe(2);
  });

  test("rejects inconsistent envelope status, limit and source", () => {
    expect(() => parseA2AAuditSnapshot(snapshot([], { status: "truncated" }), 10)).toThrow();
    expect(() => parseA2AAuditSnapshot(snapshot([], { limit: 9 }), 10)).toThrow();
    expect(() => parseA2AAuditSnapshot(snapshot([], { source: "another_file" }), 10)).toThrow();
    expect(() => parseA2AAuditSnapshot(snapshot([upstream("a2a_audit:1")], { status: "missing" }), 10)).toThrow();
  });
});

type StoredAudit = {
  source: "a2a_audit" | "policy_denials";
  sourceOffset: string;
  sourceKind: string;
  ts: number;
  direction: string;
  peer: string;
  taskId: string | null;
};

const auditScope: A2AAuditScope = {
  userId: "83000000-0000-4000-8000-000000000001",
  agencyId: "83000000-0000-4000-8000-000000000002",
  clientId: "83000000-0000-4000-8000-000000000003",
};
const auditRuntime = "83000000-0000-4000-8000-000000000004";

function auditDatabase() {
  let mandate = true;
  const records = new Map<string, StoredAudit>();
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    if (sql.includes("set_config('app.organization_id'")) return [];
    if (sql.includes("workspace_access(")) return mandate ? [{ viaAgencyIds: [auditScope.agencyId] }] : [];
    if (sql.includes("select id from runtimes")) return [{ id: auditRuntime }];
    if (sql.includes("insert into runtime_a2a_audit")) {
      const record: StoredAudit = {
        source: String(values[2]) as StoredAudit["source"],
        sourceOffset: String(values[3]),
        sourceKind: String(values[4]),
        ts: Number(values[5]),
        direction: String(values[6]),
        peer: String(values[7]),
        taskId: values[8] === null ? null : String(values[8]),
      };
      const key = `${record.source}:${record.sourceOffset}`;
      if (records.has(key)) return [];
      records.set(key, record);
      return [{ sourceOffset: record.sourceOffset }];
    }
    if (sql.includes("select exists")) {
      const record = records.get(`${String(values[2])}:${String(values[3])}`);
      return [{ present: record !== undefined
        && record.sourceKind === values[4]
        && record.ts === Number(values[5])
        && record.direction === values[6]
        && record.peer === values[7]
        && record.taskId === values[8] }];
    }
    if (sql.includes("select ts from runtime_a2a_audit")) {
      const record = records.get(`${String(values[2])}:${String(values[3])}`);
      return record ? [{ ts: record.ts }] : [];
    }
    if (sql.includes("select count(*)::text as total from runtime_a2a_audit")) {
      return [{ total: String(records.size) }];
    }
    if (sql.includes("from runtime_a2a_audit")) {
      const allowedSources = new Set([String(values[2]), String(values[3])]);
      let rows = [...records.values()].filter((record) => allowedSources.has(record.source));
      if (sql.includes("(ts, source, source_offset) <")) {
        const cursor = { ts: Number(values[4]), source: String(values[5]), sourceOffset: String(values[6]) };
        rows = rows.filter((row) => {
          if (row.ts !== cursor.ts) return row.ts < cursor.ts;
          if (row.source !== cursor.source) return row.source < cursor.source;
          return BigInt(row.sourceOffset) < BigInt(cursor.sourceOffset);
        });
      }
      rows.sort((left, right) => {
        if (left.ts !== right.ts) return right.ts - left.ts;
        if (left.source !== right.source) return right.source.localeCompare(left.source);
        return BigInt(left.sourceOffset) > BigInt(right.sourceOffset) ? -1 : BigInt(left.sourceOffset) < BigInt(right.sourceOffset) ? 1 : 0;
      });
      const limit = Number(values.at(-1));
      return rows.slice(0, limit).map((record) => ({
        id: `${record.source}:${record.sourceOffset}`,
        sourceFile: record.source,
        sourceKind: record.sourceKind,
        ts: record.ts,
        direction: record.direction,
        peer: record.peer,
        taskId: record.taskId,
        sourceOffset: record.sourceOffset,
      }));
    }
    return [];
  }) as unknown as SQL;
  db.begin = (async (callback: (tx: SQL) => Promise<unknown>) => callback(db)) as SQL["begin"];
  return { db: db as unknown as Db, records, revoke() { mandate = false; } };
}

function policyGuardRecord(id: string, taskId?: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: "operator.policy_guard",
    ts: 1_760_000_010,
    direction: "denied",
    peer: "alpha",
    ...(taskId === undefined ? {} : { taskId }),
    ...overrides,
  };
}

describe("A2A audit source-file projection", () => {
  test("persists same offset from both fixed files and paginates by timestamp, file, then offset", async () => {
    const state = auditDatabase();
    const refresh = await refreshAgencyA2AAudit(state.db, auditScope, auditRuntime, async () => snapshot([
      upstream("a2a_audit:9", { ts: 1_760_000_010 }),
      policyGuardRecord("policy_denials:9"),
      upstream("a2a_audit:10", { ts: 1_760_000_010 }),
    ]), { limit: 10 });
    expect(refresh.insertedRecords).toBe(3);
    expect(state.records.size).toBe(3);
    expect(state.records.get("policy_denials:9")?.taskId).toBeNull();

    const first = await readAgencyA2AAuditPage(state.db, auditScope, auditRuntime, { limit: 1 });
    expect(first.records.map((record) => record.id)).toEqual(["policy_denials:9"]);
    expect(first.nextCursor).toBe("policy_denials:9");
    const second = await readAgencyA2AAuditPage(state.db, auditScope, auditRuntime, { limit: 1, cursor: first.nextCursor });
    expect(second.records.map((record) => record.id)).toEqual(["a2a_audit:10"]);
    const third = await readAgencyA2AAuditPage(state.db, auditScope, auditRuntime, { limit: 1, cursor: second.nextCursor });
    expect(third.records.map((record) => record.id)).toEqual(["a2a_audit:9"]);
  });

  test("same source-file offset with changed metadata is an immutable collision", async () => {
    const state = auditDatabase();
    await refreshAgencyA2AAudit(state.db, auditScope, auditRuntime, async () => snapshot([
      policyGuardRecord("policy_denials:12"),
    ]), { limit: 10 });
    await expect(refreshAgencyA2AAudit(state.db, auditScope, auditRuntime, async () => snapshot([
      policyGuardRecord("policy_denials:12", undefined, { peer: "beta" }),
    ]), { limit: 10 })).rejects.toMatchObject({ code: "A2A_AUDIT_ID_COLLISION", status: 409 });
  });

  test("revalidates mandate after host success and failure before projecting records", async () => {
    for (const failHost of [false, true]) {
      const state = auditDatabase();
      await expect(refreshAgencyA2AAudit(state.db, auditScope, auditRuntime, async () => {
        state.revoke();
        if (failHost) throw new Error("private host detail");
        return snapshot([policyGuardRecord("policy_denials:99")]);
      }, { limit: 10 })).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_REVOKED", status: 403 });
      expect(state.records.size).toBe(0);
    }
  });
});
