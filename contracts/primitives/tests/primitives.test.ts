import { describe, expect, test } from "bun:test";
import {
  UUID_LOOSE_BODY,
  UUID_LOOSE_RE,
  UUID_STRICT_BODY,
  UUID_STRICT_RE,
  asRecord,
  isRecord,
  isStrictUuid,
  isUuid,
  isoInstant,
  isoInstantLenient,
  isoOrNull,
  isoUnlessNull,
  stringValue,
} from "../src/index";

const V4 = "3f2b8c1e-5a47-4d9a-8b6e-1c2d3e4f5a6b";
const V7 = "018f3e8a-7b1c-7a2d-9c4e-5f6a7b8c9d0e";
const NIL = "00000000-0000-0000-0000-000000000000";

describe("uuid", () => {
  test("UUID_STRICT_RE and isStrictUuid accept v4 and v7, refuse the nil UUID and text", () => {
    expect(UUID_STRICT_RE.test(V4) && UUID_STRICT_RE.test(V7)).toBe(true);
    expect(isStrictUuid(V4.toUpperCase())).toBe(true);
    expect(isStrictUuid(V7)).toBe(true);
    expect(isStrictUuid(NIL)).toBe(false);
    expect(isStrictUuid("not-a-uuid")).toBe(false);
  });

  test("UUID_LOOSE_RE and isUuid accept any 8-4-4-4-12 hex, refuse text", () => {
    expect(UUID_LOOSE_RE.test(V4) && UUID_LOOSE_RE.test(V7)).toBe(true);
    expect(isUuid(NIL)).toBe(true);
    expect(isUuid(V4)).toBe(true);
    expect(isUuid(V7)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });

  test("the bodies compose into a longer pattern", () => {
    expect(new RegExp(`^org/(${UUID_LOOSE_BODY})/${UUID_STRICT_BODY}$`, "i").test(`org/${NIL}/${V4}`)).toBe(true);
  });
});

describe("iso", () => {
  const date = new Date("2026-01-02T03:04:05.678Z");

  test("isoInstant renders a Date or a date string and throws on garbage", () => {
    expect(isoInstant(date)).toBe("2026-01-02T03:04:05.678Z");
    expect(isoInstant("2026-01-02T04:04:05+01:00")).toBe("2026-01-02T03:04:05.000Z");
    expect(() => isoInstant("nope")).toThrow(RangeError);
  });

  test("isoInstantLenient returns a non-date string untouched", () => {
    expect(isoInstantLenient(date)).toBe("2026-01-02T03:04:05.678Z");
    expect(isoInstantLenient("2026-01-02T04:04:05+01:00")).toBe("2026-01-02T03:04:05.000Z");
    expect(isoInstantLenient("nope")).toBe("nope");
  });

  test("isoOrNull maps every falsy value to null", () => {
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull("")).toBeNull();
    expect(isoOrNull(date)).toBe("2026-01-02T03:04:05.678Z");
  });

  test("isoUnlessNull maps only null to null", () => {
    expect(isoUnlessNull(null)).toBeNull();
    expect(isoUnlessNull(date)).toBe("2026-01-02T03:04:05.678Z");
    expect(() => isoUnlessNull("")).toThrow(RangeError);
  });
});

describe("record", () => {
  test("isRecord accepts plain objects only", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
  });

  test("asRecord returns the object or null", () => {
    const value = { a: 1 };
    expect(asRecord(value)).toBe(value);
    expect(asRecord([value])).toBeNull();
    expect(asRecord(undefined)).toBeNull();
  });

  test("stringValue keeps a non-empty string only", () => {
    expect(stringValue("x")).toBe("x");
    expect(stringValue("")).toBeNull();
    expect(stringValue(3)).toBeNull();
  });
});
