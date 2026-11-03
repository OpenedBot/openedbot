import { describe, expect, test } from "bun:test";
import { isServiceStepKind, SERVICE_STEP_KINDS } from "../src/domain/run-step";

describe("isServiceStepKind", () => {
  test("memory, persona_draft et compaction sont des runs de service", () => {
    expect(SERVICE_STEP_KINDS).toContain("compaction");
    expect(isServiceStepKind("compaction")).toBe(true);
    expect(isServiceStepKind("memory")).toBe(true);
    expect(isServiceStepKind("root")).toBe(false);
    expect(isServiceStepKind(null)).toBe(false);
  });
});
