import { describe, expect, test } from "bun:test";
import { enrolledRuntimeActivation } from "../src/application/enroll-activation";

const dead = { id: "old", isActive: true, reachability: "connector", linkConnectedAt: null };
const live = { id: "old", isActive: true, reachability: "connector", linkConnectedAt: new Date() };

describe("enrolledRuntimeActivation", () => {
  test("an organization with no active runtime activates the new one", () => {
    expect(enrolledRuntimeActivation([])).toEqual({ active: true, retireId: null });
    expect(enrolledRuntimeActivation([{ ...dead, isActive: false }])).toEqual({ active: true, retireId: null });
  });

  test("a dead connector is retired so the new runtime can take its place", () => {
    expect(enrolledRuntimeActivation([dead])).toEqual({ active: true, retireId: "old" });
  });

  test("a connector whose link is open, and a direct runtime, stay active", () => {
    expect(enrolledRuntimeActivation([live])).toEqual({ active: false, retireId: null });
    expect(enrolledRuntimeActivation([{ id: "direct", isActive: true, reachability: "direct", linkConnectedAt: null }]))
      .toEqual({ active: false, retireId: null });
  });
});
