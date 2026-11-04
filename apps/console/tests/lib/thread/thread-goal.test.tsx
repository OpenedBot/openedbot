import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { saveCloudSession, syncCloudSession } from "../../../src/lib/session/cloud-session";
import { clearThreadGoals, useThreadGoal } from "../../../src/lib/thread/thread-goal";

afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear(); });

describe("useThreadGoal", () => {
  test("un autre utilisateur du même bot ne retrouve pas l'objectif du précédent", () => {
    saveCloudSession({ organizationId: "org", csrfToken: "csrf-a", userId: "user-a" });
    const first = renderHook(() => useThreadGoal("bot:one"));
    act(() => first.result.current[1]("Objectif privé"));
    expect(first.result.current[0]).toBe("Objectif privé");
    first.unmount();

    saveCloudSession({ organizationId: "org", csrfToken: "csrf-b", userId: "user-b" });
    expect(renderHook(() => useThreadGoal("bot:one")).result.current[0]).toBeNull();
  });

  test("chaque organisation garde son propre objectif", () => {
    saveCloudSession({ organizationId: "a", csrfToken: "csrf", userId: "user" });
    const inA = renderHook(() => useThreadGoal("bot:one"));
    act(() => inA.result.current[1]("Pour A"));
    inA.unmount();
    syncCloudSession({ organizationId: "b", csrfToken: "csrf", userId: "user" });
    expect(renderHook(() => useThreadGoal("bot:one")).result.current[0]).toBeNull();
  });

  test("la déconnexion efface tous les objectifs, ancien format compris", () => {
    saveCloudSession({ organizationId: "org", csrfToken: "csrf", userId: "user" });
    window.localStorage.setItem("ohb.threadGoal.bot:legacy", "Ancien objectif");
    const goal = renderHook(() => useThreadGoal("bot:one"));
    act(() => goal.result.current[1]("Objectif"));
    goal.unmount();

    clearThreadGoals();
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("ohb.threadGoal."))).toEqual([]);
    expect(renderHook(() => useThreadGoal("bot:one")).result.current[0]).toBeNull();
  });
});
