import { describe, expect, test } from "bun:test";
import {
  RoutineToolInputError,
  normalizeRoutineSchedule,
  readRoutineToolArgs,
  routineToolWriteRight,
  scheduleRespectsMinimumInterval,
  withRoutineRunKey,
} from "../src/domain/routine-tool";
import { readRoutineRunKey, signRoutineRunKey } from "../src/application/routine-run-key";

const RUN = "92090000-0000-4000-8000-000000000101";

describe("routine_manage (DEV-209)", () => {
  test("les formes courantes deviennent un cron 5 champs, le reste est refusé", () => {
    expect(normalizeRoutineSchedule("0 9 * * 1-5")).toBe("0 9 * * 1-5");
    expect(normalizeRoutineSchedule("hourly")).toBe("0 * * * *");
    expect(normalizeRoutineSchedule("every 2h")).toBe("0 */2 * * *");
    expect(normalizeRoutineSchedule("every 30 minutes")).toBe("*/30 * * * *");
    expect(normalizeRoutineSchedule("Daily at 9am")).toBe("0 9 * * *");
    expect(normalizeRoutineSchedule("every day at 21:15")).toBe("15 21 * * *");
    expect(normalizeRoutineSchedule("weekdays at 9h30")).toBe("30 9 * * 1-5");
    expect(normalizeRoutineSchedule("every monday at 8am")).toBe("0 8 * * 1");
    expect(normalizeRoutineSchedule("in 30m")).toBeNull();
    expect(normalizeRoutineSchedule("every day at 25:00")).toBeNull();
    expect(normalizeRoutineSchedule("tous les jours")).toBeNull();
  });

  test("un tir plus serré que 15 minutes est refusé", () => {
    const now = new Date("2026-10-07T10:00:00Z");
    expect(scheduleRespectsMinimumInterval("*/30 * * * *", "UTC", now)).toBe(true);
    expect(scheduleRespectsMinimumInterval("*/5 * * * *", "UTC", now)).toBe(false);
    expect(scheduleRespectsMinimumInterval("0,5 9 * * *", "UTC", now)).toBe(false);
    expect(scheduleRespectsMinimumInterval("0 0 31 2 *", "UTC", now)).toBe(false);
  });

  test("les arguments sont lus strictement", () => {
    expect(readRoutineToolArgs({ action: "list", run_key: "k" })).toMatchObject({ action: "list", jobId: null });
    expect(() => readRoutineToolArgs({ action: "list" })).toThrow(RoutineToolInputError);
    expect(() => readRoutineToolArgs({ action: "run", run_key: "k" })).toThrow(RoutineToolInputError);
    expect(() => readRoutineToolArgs({ action: "create", run_key: "k", name: "n", prompt: "p" })).toThrow(RoutineToolInputError);
    expect(() => readRoutineToolArgs({ action: "pause", run_key: "k" })).toThrow(RoutineToolInputError);
    expect(() => readRoutineToolArgs({ action: "list", run_key: "k", timezone: "Mars/Olympus" })).toThrow(RoutineToolInputError);
  });

  test("la clé de run se relit avec le même secret, et seulement avec lui", () => {
    const key = signRoutineRunKey("secret", RUN);
    expect(readRoutineRunKey("secret", key)).toBe(RUN);
    expect(readRoutineRunKey("other", key)).toBeNull();
    expect(readRoutineRunKey("secret", `${RUN}.forged`)).toBeNull();
    expect(readRoutineRunKey("secret", "not-a-run.abc")).toBeNull();
    expect(withRoutineRunKey("bonjour", key)).toBe(`bonjour\n\n[routine_manage run_key: ${key}]`);
  });
});

describe("routine_manage write right (PERM2-9)", () => {
  test("plan refuses, auto and bypass activate, everything else stays paused", () => {
    expect(routineToolWriteRight("plan")).toBe("refused");
    expect(routineToolWriteRight("auto")).toBe("active");
    expect(routineToolWriteRight("bypass")).toBe("active");
    expect(routineToolWriteRight("manual")).toBe("paused");
    // A mode this code does not know, or no bot row, never activates.
    for (const mode of [null, "", "superuser", "AUTO", "bypass ", "plan_v2"]) expect(routineToolWriteRight(mode)).toBe("paused");
  });
});
