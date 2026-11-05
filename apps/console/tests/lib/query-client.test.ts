import { describe, expect, test } from "bun:test";
import { ApiError, queryKeys } from "../../src/lib/api";
import { createInvalidateScheduler, DEFAULT_INVALIDATE_DELAY_MS, shouldRetryQuery } from "../../src/lib/query-client";

type FakeTimer = { callback: () => void; delayMs: number };

function fakeClock() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimer: (callback: () => void, delayMs: number) => {
      timers.push({ callback, delayMs });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    fire() {
      const due = timers.splice(0, timers.length);
      for (const timer of due) timer.callback();
    },
  };
}

describe("createInvalidateScheduler", () => {
  test("dix demandes pour la même clé dans la fenêtre : une seule invalidation, à l'échéance", () => {
    const clock = fakeClock();
    const invalidated: unknown[][] = [];
    const scheduler = createInvalidateScheduler({
      invalidate: (queryKey) => invalidated.push([...queryKey]),
      setTimer: clock.setTimer,
    });
    for (let index = 0; index < 10; index += 1) {
      scheduler.schedule(["organization", "org-1", "roster"]);
    }
    expect(invalidated).toEqual([]);
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0]!.delayMs).toBe(DEFAULT_INVALIDATE_DELAY_MS);
    expect(scheduler.pending()).toBe(1);

    clock.fire();
    expect(invalidated).toEqual([["organization", "org-1", "roster"]]);
    expect(scheduler.pending()).toBe(0);
  });

  test("deux clés distinctes ont chacune leur échéance", () => {
    const clock = fakeClock();
    const invalidated: string[] = [];
    const scheduler = createInvalidateScheduler({
      invalidate: (queryKey) => invalidated.push(String(queryKey[2])),
      setTimer: clock.setTimer,
    });
    scheduler.schedule(["organization", "org-1", "roster"]);
    scheduler.schedule(["organization", "org-1", "inbox"], 50);
    scheduler.schedule(["organization", "org-1", "roster"]);
    expect(clock.timers.map((timer) => timer.delayMs)).toEqual([DEFAULT_INVALIDATE_DELAY_MS, 50]);
    clock.fire();
    expect(invalidated).toEqual(["roster", "inbox"]);
  });

  test("après l'échéance, la même clé se reprogramme", () => {
    const clock = fakeClock();
    let count = 0;
    const scheduler = createInvalidateScheduler({
      invalidate: () => { count += 1; },
      setTimer: clock.setTimer,
    });
    scheduler.schedule(["a"]);
    clock.fire();
    scheduler.schedule(["a"]);
    scheduler.schedule(["a"]);
    clock.fire();
    expect(count).toBe(2);
  });

  test("l'identité de clé est structurelle, pas référentielle", () => {
    const clock = fakeClock();
    let count = 0;
    const scheduler = createInvalidateScheduler({
      invalidate: () => { count += 1; },
      setTimer: clock.setTimer,
    });
    scheduler.schedule(["organization", "org-1", "thread", "t-1"]);
    scheduler.schedule(["organization", "org-1", "thread", "t-1"]);
    scheduler.schedule(["organization", "org-1", "thread", "t-2"]);
    expect(scheduler.pending()).toBe(2);
    clock.fire();
    expect(count).toBe(2);
  });
});

describe("shouldRetryQuery", () => {
  test("une erreur ordinaire garde son unique nouvel essai", () => {
    const error = new ApiError(503, "Indisponible");
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(false);
  });

  test("WORKSPACE_CHANGED ne se rejoue jamais : la reprise lirait l'autre espace sous l'ancienne clé", () => {
    expect(shouldRetryQuery(0, new ApiError(409, "Le contexte de l’espace a changé.", "WORKSPACE_CHANGED"))).toBe(false);
  });

  test("un 401 de session ne se rejoue pas", () => {
    expect(shouldRetryQuery(0, new ApiError(401, "Session expirée.", "SESSION_EXPIRED"))).toBe(false);
  });
});

describe("queryKeys.globalSearch", () => {
  test("le même terme cherché dans deux espaces n'occupe pas la même entrée du cache", () => {
    window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-a", csrfToken: "csrf", userId: "user-1" }));
    window.sessionStorage.clear();
    const inA = queryKeys.globalSearch("budget");
    window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-b", csrfToken: "csrf", userId: "user-1" }));
    window.sessionStorage.clear();
    const inB = queryKeys.globalSearch("budget");
    expect(inA).toEqual(["organization", "org-a", "global-search", "budget"]);
    expect(inB).toEqual(["organization", "org-b", "global-search", "budget"]);
  });
});
