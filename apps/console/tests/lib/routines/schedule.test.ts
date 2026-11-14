import { describe, expect, test } from "bun:test";
import type { RoutineDto } from "@openedbot/contracts-api";
import { isValidCron } from "@openedbot/execution/domain/routines";
import {
  DEFAULT_SCHEDULE,
  cronFromDraft,
  draftFromCron,
  oneShotOverdue,
  oneShotSent,
  parseTimeValue,
  routinePatch,
  routineZoneDiffers,
  timeValue,
  type ScheduleDraft,
} from "../../../src/lib/routines/schedule";

const draft = (patch: Partial<ScheduleDraft>): ScheduleDraft => ({ ...DEFAULT_SCHEDULE, ...patch });

describe("preset ↔ cron", () => {
  test("each preset writes a plain 5-field cron, read back as the same preset", () => {
    const cases: Array<[ScheduleDraft, string]> = [
      [draft({ kind: "hourly", minute: 15 }), "15 * * * *"],
      [draft({ kind: "daily", hour: 17, minute: 30 }), "30 17 * * *"],
      [draft({ kind: "weekdays", hour: 8, minute: 5 }), "5 8 * * 1-5"],
      [draft({ kind: "weekly", weekday: 0, hour: 9, minute: 0 }), "0 9 * * 0"],
      [draft({ kind: "weekly", weekday: 5, hour: 23, minute: 59 }), "59 23 * * 5"],
    ];
    for (const [input, cron] of cases) {
      expect(cronFromDraft(input)).toBe(cron);
      expect(isValidCron(cron)).toBe(true);
      const back = draftFromCron(cron);
      expect(back.kind).toBe(input.kind);
      expect(cronFromDraft(back)).toBe(cron);
    }
  });

  test("every day at 17:30 reads as a daily preset at 17:30", () => {
    expect(draftFromCron("30 17 * * *")).toMatchObject({ kind: "daily", hour: 17, minute: 30 });
  });

  test("a cron that fits no preset opens as custom, its text untouched", () => {
    for (const cron of ["*/15 * * * *", "0 9 * * 7", "05 9 * * *", "0 9 1 * *", "0  9 * * *", "0 8-18/2 * * 1-5", "0 9 * * 1,3"]) {
      const back = draftFromCron(cron);
      expect(back.kind).toBe("custom");
      expect(back.cron).toBe(cron);
    }
  });

  test("an out-of-range or empty field writes no cron", () => {
    expect(cronFromDraft(draft({ kind: "hourly", minute: 60 }))).toBeNull();
    expect(cronFromDraft(draft({ kind: "daily", hour: Number.NaN }))).toBeNull();
    expect(cronFromDraft(draft({ kind: "custom", cron: "tous les jours" }))).toBeNull();
    expect(cronFromDraft(draft({ kind: "custom", cron: "  0 9 * * 1-5 " }))).toBe("0 9 * * 1-5");
  });

  test("the time input value round-trips", () => {
    expect(timeValue({ hour: 7, minute: 5 })).toBe("07:05");
    expect(parseTimeValue("17:30")).toEqual({ hour: 17, minute: 30 });
    expect(parseTimeValue("")).toBeNull();
    expect(parseTimeValue("25:00")).toBeNull();
  });
});

const routine = (patch: Partial<RoutineDto> = {}): RoutineDto => ({
  id: "r-1", botId: "bot-1", groupId: null, name: "Revue", schedule: "0 9 * * *", timezone: "Europe/Paris",
  message: "Résume", enabled: true, nextRunAt: null, lastRunAt: null, missedCount: 0, lastMissedAt: null,
  waitingForHost: false, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", neverWait: false,
  ...patch,
});

describe("edit patch", () => {
  test("sends only what changed, trimmed", () => {
    const base = routine();
    const same = { name: "Revue", message: "Résume", schedule: "0 9 * * *", timezone: "Europe/Paris" };
    expect(routinePatch(base, same)).toEqual({});
    expect(routinePatch(base, { ...same, name: " Revue du soir " })).toEqual({ name: "Revue du soir" });
    expect(routinePatch(base, { ...same, schedule: "30 17 * * *" })).toEqual({ schedule: "30 17 * * *" });
    expect(routinePatch(base, { ...same, timezone: "America/New_York" })).toEqual({ timezone: "America/New_York" });
  });

  test("a one-shot never sends a schedule or a zone", () => {
    const once = routine({ schedule: "at 2026-12-01T08:00:00Z" });
    expect(routinePatch(once, { name: "Revue", message: "Autre", schedule: "0 9 * * *", timezone: "UTC" })).toEqual({ message: "Autre" });
  });
});

describe("zone and one-shot state", () => {
  test("the zone is named only for a recurring routine outside the reader's zone", () => {
    expect(routineZoneDiffers(routine(), "Europe/Paris")).toBe(false);
    expect(routineZoneDiffers(routine(), "America/New_York")).toBe(true);
    expect(routineZoneDiffers(routine({ schedule: "at 2026-12-01T08:00:00Z" }), "America/New_York")).toBe(false);
  });

  test("a one-shot run manually before its time, then paused, is not sent", () => {
    const once = routine({ schedule: "at 2026-12-01T08:00:00Z", enabled: false, lastRunAt: "2026-11-20T10:00:00.000Z" });
    expect(oneShotSent(once)).toBe(false);
    expect(oneShotOverdue(once, new Date("2026-11-21T00:00:00Z"))).toBe(false);
    expect(oneShotOverdue(once, new Date("2026-12-02T00:00:00Z"))).toBe(true);
  });

  test("a one-shot fired by the tick is sent, never overdue", () => {
    const fired = routine({ schedule: "at 2026-12-01T08:00:00Z", enabled: false, lastRunAt: "2026-12-01T08:00:01.000Z" });
    expect(oneShotSent(fired)).toBe(true);
    expect(oneShotOverdue(fired, new Date("2026-12-02T00:00:00Z"))).toBe(false);
  });

  test("an enabled or recurring routine is neither", () => {
    expect(oneShotOverdue(routine({ schedule: "at 2026-12-01T08:00:00Z" }), new Date("2026-12-02T00:00:00Z"))).toBe(false);
    expect(oneShotSent(routine({ enabled: false, lastRunAt: "2026-12-01T08:00:00.000Z" }))).toBe(false);
  });
});
