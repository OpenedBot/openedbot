import { describe, expect, test } from "bun:test";
import { assertMemberCapacity, assertMutableMemberRole } from "../src/domain/member-policy";

describe("SaaS member policy", () => {
  test("a pending invitation holds its seat inside the plan's member limit", () => {
    expect(() => assertMemberCapacity(2, 1)).not.toThrow();
    expect(() => assertMemberCapacity(2, 2)).toThrow(expect.objectContaining({ status: 409, code: "MEMBER_QUOTA_REACHED" }));
    expect(() => assertMemberCapacity(-1, 0)).toThrow(/invalid/);
  });

  test("protects the organization owner", () => {
    expect(() => assertMutableMemberRole("member")).not.toThrow();
    expect(() => assertMutableMemberRole("owner")).toThrow(/owner/i);
  });
});
