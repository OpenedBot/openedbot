import { describe, expect, test } from "bun:test";
import { encodeThreadHistoryCursor, parseThreadHistoryCursor, parseThreadHistoryLimit } from "../src/domain/thread-history-cursor";

const organizationId = crypto.randomUUID();
const threadId = crypto.randomUUID();

describe("thread history cursor", () => {
  test("retains microseconds and the deterministic tie breakers", () => {
    const anchor = { kind: "message" as const, id: crypto.randomUUID(), createdAt: "2026-10-05T00:00:00.123456Z" };
    const cursor = encodeThreadHistoryCursor(organizationId, threadId, anchor);
    expect(parseThreadHistoryCursor(cursor, organizationId, threadId)).toEqual(anchor);
    expect(parseThreadHistoryCursor(undefined, organizationId, threadId)).toBeNull();
  });

  test("a cursor is rejected in another tenant or thread", () => {
    const cursor = encodeThreadHistoryCursor(organizationId, threadId, { kind: "run", id: crypto.randomUUID(), createdAt: "2026-10-05T00:00:00.000001Z" });
    expect(() => parseThreadHistoryCursor(cursor, crypto.randomUUID(), threadId)).toThrow();
    expect(() => parseThreadHistoryCursor(cursor, organizationId, crypto.randomUUID())).toThrow();
  });

  test("malformed and oversized cursors fail before SQL", () => {
    for (const value of ["", "!", "a".repeat(1025), btoa("{}"), btoa('null')]) {
      expect(() => parseThreadHistoryCursor(value, organizationId, threadId)).toThrow();
    }
    const invalid = encodeThreadHistoryCursor(organizationId, threadId, { kind: "run", id: "invalid", createdAt: "2026-10-05T00:00:00.123Z" });
    expect(() => parseThreadHistoryCursor(invalid, organizationId, threadId)).toThrow();
  });

  test("impossible calendar dates fail before PostgreSQL casts the cursor", () => {
    for (const createdAt of ["2026-02-30T00:00:00.123456Z", "0000-01-01T00:00:00.123456Z", "2026-10-05T24:00:00.123456Z"]) {
      const cursor = encodeThreadHistoryCursor(organizationId, threadId, { kind: "run", id: crypto.randomUUID(), createdAt });
      expect(() => parseThreadHistoryCursor(cursor, organizationId, threadId)).toThrow();
    }
  });

  test("page size is bounded without silently changing invalid input", () => {
    expect(parseThreadHistoryLimit(undefined)).toBe(40);
    expect(parseThreadHistoryLimit("100")).toBe(100);
    for (const value of ["0", "101", "-1", "1.5", "", "2e1"]) expect(() => parseThreadHistoryLimit(value)).toThrow();
  });
});
