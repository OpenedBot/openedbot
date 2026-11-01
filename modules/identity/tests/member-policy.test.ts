import { describe, expect, test } from "bun:test";
import { assertMemberCapacity, assertMutableMemberRole } from "../src/domain/member-policy";

describe("SaaS member policy", () => {
  test("reserves the pending invitation inside the two-member quota", () => {
    expect(() => assertMemberCapacity(2, 1)).not.toThrow();
    expect(() => assertMemberCapacity(2, 2)).toThrow(/limite de deux membres/i);
  });

  test("protects the organization owner", () => {
    expect(() => assertMutableMemberRole("member")).not.toThrow();
    expect(() => assertMutableMemberRole("owner")).toThrow(/owner/i);
  });
});
