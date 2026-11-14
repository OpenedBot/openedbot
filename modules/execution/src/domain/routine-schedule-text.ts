/**
 * A routine's schedule in plain words, in one place for every reader: the
 * console's routine list and form, and the description of a `routine_manage`
 * approval gate, which the API builds for every client and the reviewer
 * (`routine-gate-text.ts`). Pure: the caller brings its translator and its
 * date and number formats (the console's `useT`, or `localeFormat` on the
 * server, kept apart so the console bundle never loads every dictionary).
 *
 * The schedule a person picks in the routine form, and the plain 5-field
 * cron it stands for. A preset always writes one canonical cron; reading a
 * cron back only lands on a preset when that preset writes the very same
 * string, so a routine whose cron fits no preset opens as « custom » with its
 * text untouched (`0 9 * * 7`, extra spaces, steps...).
 */
import type { MessageKey } from "@openedbot/contracts-i18n";
import { isValidCron, oneShotTime } from "./routines";

export type ScheduleKind = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

export type ScheduleDraft = {
  kind: ScheduleKind;
  /** 0-59. */
  minute: number;
  /** 0-23; unused by `hourly`. */
  hour: number;
  /** 0 (Sunday) to 6; used by `weekly` only. */
  weekday: number;
  /** The raw expression of `custom`. */
  cron: string;
};

export const DEFAULT_SCHEDULE: ScheduleDraft = { kind: "daily", minute: 0, hour: 9, weekday: 1, cron: "" };

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** The cron a draft stands for; `null` while a field is out of range. */
export function cronFromDraft(draft: ScheduleDraft): string | null {
  if (draft.kind === "custom") {
    const cron = draft.cron.trim();
    return isValidCron(cron) ? cron : null;
  }
  if (!inRange(draft.minute, 0, 59)) return null;
  if (draft.kind === "hourly") return `${draft.minute} * * * *`;
  if (!inRange(draft.hour, 0, 23)) return null;
  if (draft.kind === "daily") return `${draft.minute} ${draft.hour} * * *`;
  if (draft.kind === "weekdays") return `${draft.minute} ${draft.hour} * * 1-5`;
  if (!inRange(draft.weekday, 0, 6)) return null;
  return `${draft.minute} ${draft.hour} * * ${draft.weekday}`;
}

/** The draft a stored cron opens as. */
export function draftFromCron(cron: string): ScheduleDraft {
  const match = /^(\d{1,2}) (\*|\d{1,2}) \* \* (\*|1-5|\d)$/.exec(cron);
  if (match) {
    const minute = Number(match[1]);
    const hour = match[2] === "*" ? DEFAULT_SCHEDULE.hour : Number(match[2]);
    const dow = match[3]!;
    const kind: ScheduleKind | null = match[2] === "*"
      ? (dow === "*" ? "hourly" : null)
      : dow === "*" ? "daily" : dow === "1-5" ? "weekdays" : "weekly";
    if (kind) {
      const candidate: ScheduleDraft = {
        kind,
        minute,
        hour,
        weekday: kind === "weekly" ? Number(dow) : DEFAULT_SCHEDULE.weekday,
        cron,
      };
      if (cronFromDraft(candidate) === cron) return candidate;
    }
  }
  return { ...DEFAULT_SCHEDULE, kind: "custom", cron };
}

/**
 * A recurring routine is read in its own zone: the list names that zone only
 * when it is not the reader's, where « tous les jours à 9h » would otherwise
 * be read in the wrong one. A one-shot is an absolute instant, shown in the
 * reader's zone, so its zone never needs naming.
 */
export function routineZoneDiffers(routine: { schedule: string; timezone: string }, viewerZone: string): boolean {
  return oneShotTime(routine.schedule) === null && routine.timezone !== viewerZone;
}

/** The translator and formats a reader brings: the console's `useT`, or `localeFormat` (`locale-format.ts`). */
export type TextFormat = {
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
  formatDate: (value: Date, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
};

/** Hours, minutes and weekdays in the reader's language, never in a zone: they are wall-clock values. */
export function scheduleText({ t, formatDate }: TextFormat) {
  const time = (hour: number, minute: number) =>
    formatDate(new Date(Date.UTC(2000, 0, 1, hour, minute)), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  // 2000-01-02 is a Sunday: day 0 of a cron.
  const weekday = (day: number) => formatDate(new Date(Date.UTC(2000, 0, 2 + day)), { weekday: "long", timeZone: "UTC" });

  const describeDraft = (draft: ScheduleDraft): string => {
    const cron = cronFromDraft(draft);
    if (cron === null) return t("botRoutinesDialog.scheduleInvalid");
    if (draft.kind === "custom") return cron;
    if (draft.kind === "hourly") {
      return draft.minute === 0
        ? t("botRoutinesDialog.scheduleHourlyOnTheHour")
        : t("botRoutinesDialog.scheduleHourly", { minute: draft.minute });
    }
    const at = time(draft.hour, draft.minute);
    if (draft.kind === "daily") return t("botRoutinesDialog.scheduleDaily", { time: at });
    if (draft.kind === "weekdays") return t("botRoutinesDialog.scheduleWeekdays", { time: at });
    return t("botRoutinesDialog.scheduleWeekly", { weekday: weekday(draft.weekday), time: at });
  };

  /**
   * A one-shot's instant, in `timeZone` or the reader's. The date and the time
   * are formatted apart and joined by the message's own « à » / "at": with
   * `dateStyle` and `timeStyle` together, the connector comes from the
   * runtime's CLDR data (« à » on macOS, « , » on the Linux servers), and this
   * sentence is read in an approval gate, so it must not vary by platform.
   */
  const describeOnce = (once: Date, timeZone?: string): string => {
    const zone = timeZone ? { timeZone } : {};
    return t("botRoutinesDialog.oneShotAt", {
      date: formatDate(once, { dateStyle: "medium", ...zone }),
      time: formatDate(once, { timeStyle: "short", ...zone }),
    });
  };

  /** The list's line: names the routine's zone when it is not the reader's. */
  const describeRoutine = (routine: { schedule: string; timezone: string }, viewerZone: string): string => {
    const once = oneShotTime(routine.schedule);
    if (once) return describeOnce(once);
    const schedule = describeDraft(draftFromCron(routine.schedule));
    return routineZoneDiffers(routine, viewerZone)
      ? t("botRoutinesDialog.scheduleInZone", { schedule, timezone: routine.timezone })
      : schedule;
  };

  /** A schedule read in `timezone` and saying so: a one-shot's date is that zone's wall clock. */
  const describeInZone = (schedule: string, timezone: string): string => {
    const once = oneShotTime(schedule);
    const text = once ? describeOnce(once, timezone) : describeDraft(draftFromCron(schedule));
    return t("botRoutinesDialog.scheduleInZone", { schedule: text, timezone });
  };

  return { time, weekday, describeDraft, describeOnce, describeRoutine, describeInZone };
}
