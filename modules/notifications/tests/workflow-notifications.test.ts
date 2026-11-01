import { describe, expect, test } from "bun:test";
import { workflowNotificationEligible } from "../src/domain/workflow-notifications";

describe("workflowNotificationEligible", () => {
  test("un DM ordinaire reste silencieux", () => {
    expect(workflowNotificationEligible({ kind: "dm", autonomyEnabled: false })).toBe(false);
  });

  test("un salon, une routine, un fait de mémoire ou un DM autonome sont éligibles", () => {
    expect(workflowNotificationEligible({ kind: "group", autonomyEnabled: false })).toBe(true);
    expect(workflowNotificationEligible({ kind: "routine", autonomyEnabled: false })).toBe(true);
    expect(workflowNotificationEligible({ kind: "dm", autonomyEnabled: true })).toBe(true);
  });
});
