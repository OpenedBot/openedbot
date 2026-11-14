import { describe, expect, test } from "bun:test";
import {
  ROUTINE_TOOL_DESCRIPTION,
  RoutineToolInputError,
  hostCarriesRoutineTool,
  normalizeRoutineSchedule,
  readRoutineToolArgs,
  routineCreateTwin,
  routineScheduleNeedsTimezone,
  routineToolAvailability,
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
    expect(normalizeRoutineSchedule("in 2m", new Date("2026-11-09T10:00:00Z"))).toBe("at 2026-11-09T10:02:00.000Z");
    expect(normalizeRoutineSchedule("every day at 25:00")).toBeNull();
    expect(normalizeRoutineSchedule("tous les jours")).toBeNull();
  });

  test("les rappels ponctuels fixent un instant, sans appliquer le minimum des récurrences", () => {
    const now = new Date("2026-11-09T10:00:00Z");
    expect(normalizeRoutineSchedule("dans 2 mn", now)).toBe("at 2026-11-09T10:02:00.000Z");
    expect(normalizeRoutineSchedule("in 1h", now)).toBe("at 2026-11-09T11:00:00.000Z");
    expect(normalizeRoutineSchedule("at 2026-11-09T10:02:00Z", now)).toBe("at 2026-11-09T10:02:00.000Z");
    for (const raw of ["in 0m", "in -2m", "in 999999h", "at 2026-02-31T10:00:00Z"]) {
      expect(normalizeRoutineSchedule(raw, now)).toBeNull();
    }
    expect(scheduleRespectsMinimumInterval("at 2026-11-09T10:02:00Z", "Europe/Paris", now)).toBe(true);
    expect(scheduleRespectsMinimumInterval("at 2026-11-09T09:00:00Z", "UTC", now)).toBe(false);
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
    expect(withRoutineRunKey("bonjour", key, "Europe/Paris"))
      .toBe(`bonjour\n\n[routine_manage run_key: ${key}]\n[routine_manage user timezone: Europe/Paris]`);
    // No zone known: the bot is told so, and asks rather than assume UTC.
    expect(withRoutineRunKey("bonjour", key, null)).toBe(`bonjour\n\n[routine_manage run_key: ${key}]\n[routine_manage user timezone: unknown]`);
  });
});

describe("routine_manage reads without a step before creating", () => {
  test("the description says `list` only reads and is no step before `create`", () => {
    expect(ROUTINE_TOOL_DESCRIPTION).toContain("`list` only reads: call it to find the `job_id` before `update`, `pause`, `resume` or `remove`");
    expect(ROUTINE_TOOL_DESCRIPTION).toContain("`create` needs no `list` first.");
    expect(ROUTINE_TOOL_DESCRIPTION).not.toContain("Always call `list`");
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

describe("routine_manage timezone (0187)", () => {
  test("a time of day needs an explicit zone; an absolute instant or a minute rhythm does not", () => {
    for (const raw of ["daily at 9am", "every friday at 17:00", "0 17 * * 5", "every 2h", "at 2026-11-13T09:00"]) {
      expect(routineScheduleNeedsTimezone(raw)).toBe(true);
    }
    for (const raw of ["in 2m", "dans 1h", "at 2026-11-13T08:00:00Z", "every 30m", "hourly", "parfois"]) {
      expect(routineScheduleNeedsTimezone(raw)).toBe(false);
    }
  });

  test("a local one-shot is read in the given zone, and refused without one", () => {
    const now = new Date("2026-11-12T10:00:00Z");
    expect(normalizeRoutineSchedule("at 2026-11-13T09:00", now, "Europe/Paris")).toBe("at 2026-11-13T08:00:00.000Z");
    expect(normalizeRoutineSchedule("at 2027-07-02T17:00", now, "Europe/Paris")).toBe("at 2027-07-02T15:00:00.000Z");
    expect(normalizeRoutineSchedule("at 2026-11-13T09:00", now)).toBeNull();
    expect(normalizeRoutineSchedule("at 2026-02-30T09:00", now, "Europe/Paris")).toBeNull();
  });

  test("daylight saving: a skipped local time is refused, a repeated one is its first instant", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    // Spring forward: 02:30 does not exist in New York on 8 March 2026, nor in Paris on 28 March 2027.
    expect(normalizeRoutineSchedule("at 2026-03-08T02:30", now, "America/New_York")).toBeNull();
    expect(normalizeRoutineSchedule("at 2027-03-28T02:30", now, "Europe/Paris")).toBeNull();
    expect(normalizeRoutineSchedule("at 2026-03-08T03:30", now, "America/New_York")).toBe("at 2026-03-08T07:30:00.000Z");
    // Fall back: 01:30 happens twice in New York on 1 November 2026, 02:30 twice in Paris on 25 October 2026.
    expect(normalizeRoutineSchedule("at 2026-11-01T01:30", now, "America/New_York")).toBe("at 2026-11-01T05:30:00.000Z");
    expect(normalizeRoutineSchedule("at 2026-10-25T02:30", now, "Europe/Paris")).toBe("at 2026-10-25T00:30:00.000Z");
    // A half-hour zone.
    expect(normalizeRoutineSchedule("at 2026-01-01T05:00", now, "Asia/Kolkata")).toBe("at 2025-12-31T23:30:00.000Z");
  });
});

describe("routine_manage availability for a run (0187)", () => {
  const LIVE = ["mcp_management", "profile_capabilities", "mcp_live_reload"];
  const base = { switchedOff: false, ready: true, blockedReason: null, linkFeatures: LIVE, hasProfile: true, botPermissionMode: "auto" };

  test("enabled only once proven and served; the operator's choice and plan mode come first", () => {
    expect(routineToolAvailability(base)).toBe("enabled");
    expect(routineToolAvailability({ ...base, botPermissionMode: "manual" })).toBe("enabled");
    expect(routineToolAvailability({ ...base, switchedOff: true })).toBe("switched_off");
    expect(routineToolAvailability({ ...base, botPermissionMode: "plan" })).toBe("plan_mode");
    expect(routineToolAvailability({ ...base, ready: false })).toBe("not_ready");
    expect(routineToolAvailability({ ...base, ready: false, blockedReason: "host_offline" })).toBe("not_ready");
    expect(routineToolAvailability({ ...base, ready: false, blockedReason: "host_unreachable" })).toBe("not_ready");
  });

  test("a host or an API that cannot carry the tool is unavailable, not pending", () => {
    expect(routineToolAvailability({ ...base, ready: false, blockedReason: "https_required" })).toBe("unavailable");
    expect(routineToolAvailability({ ...base, ready: false, linkFeatures: ["mcp_management", "mcp_live_reload"] })).toBe("unavailable");
    expect(routineToolAvailability({ ...base, ready: false, linkFeatures: ["mcp_management", "mcp_live_reload"], hasProfile: false })).toBe("not_ready");
    // A direct runtime announces no link feature: only the stored proof speaks.
    expect(routineToolAvailability({ ...base, ready: false, linkFeatures: null })).toBe("not_ready");
    expect(hostCarriesRoutineTool(["mcp_management", "profile_capabilities", "gateway_restart"], true)).toBe(true);
    expect(hostCarriesRoutineTool(["mcp_management", "profile_capabilities"], true)).toBe(false);
  });
});

describe("routine_manage create twin (2026-11-13)", () => {
  const now = new Date("2026-11-13T00:00:00.000Z");
  const base = { id: "a", name: "Actualités IA du matin", schedule: "0 9 * * *", timezone: "Europe/Paris", message: "Cherche les actualités IA", enabled: true };

  test("same schedule, zone and name up to case and spaces: the existing routine, whatever the message", () => {
    const candidate = { name: "  actualités  IA du MATIN", schedule: "0 9 * * *", timezone: "Europe/Paris", message: "Cherche les\nactualités IA " };
    expect(routineCreateTwin(candidate, [base], now)).toBe(base);
    // The model rewrites the prompt on each attempt: a reworded one is still the same routine.
    const reworded = { ...candidate, message: "Résume l'actualité IA en une phrase courte" };
    expect(routineCreateTwin(reworded, [base], now)).toBe(base);
    // A paused twin still counts: never a second one.
    const paused = { ...base, enabled: false };
    expect(routineCreateTwin(candidate, [paused], now)).toBe(paused);
  });

  test("a differing schedule, zone or name is a new routine", () => {
    for (const change of [{ schedule: "0 10 * * *" }, { timezone: "Europe/London" }, { name: "Actualités IA du soir" }]) {
      expect(routineCreateTwin({ ...base, ...change }, [base], now)).toBeNull();
    }
    expect(routineCreateTwin(base, [], now)).toBeNull();
  });

  test("a one-shot whose instant has passed is no twin; a future one is", () => {
    const past = { ...base, schedule: "at 2026-11-12T08:00:00.000Z" };
    expect(routineCreateTwin(past, [past], now)).toBeNull();
    const future = { ...base, schedule: "at 2026-11-14T08:00:00.000Z" };
    expect(routineCreateTwin(future, [future], now)).toBe(future);
  });
});
