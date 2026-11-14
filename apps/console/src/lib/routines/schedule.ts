import type { RoutineDto, UpdateRoutineInput } from "@openedbot/contracts-api";
import { oneShotTime } from "@openedbot/execution/domain/routines";
import type { ScheduleDraft, ScheduleKind } from "@openedbot/execution/domain/routine-schedule-text";

// The cron <-> preset reading is shared with the API, which describes a
// `routine_manage` approval in the same words (`routine-schedule-text.ts`).
export {
  DEFAULT_SCHEDULE,
  cronFromDraft,
  draftFromCron,
  routineZoneDiffers,
  type ScheduleDraft,
  type ScheduleKind,
} from "@openedbot/execution/domain/routine-schedule-text";

export const SCHEDULE_KINDS: readonly ScheduleKind[] = ["hourly", "daily", "weekdays", "weekly", "custom"];

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** `HH:MM`, the value of an `<input type="time">`. */
export function timeValue(draft: Pick<ScheduleDraft, "hour" | "minute">): string {
  return `${String(draft.hour).padStart(2, "0")}:${String(draft.minute).padStart(2, "0")}`;
}

/** `null` for an empty or partial `<input type="time">` value. */
export function parseTimeValue(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return inRange(hour, 0, 23) && inRange(minute, 0, 59) ? { hour, minute } : null;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * A one-shot that already went out: the tick stamps `lastRunAt` at or after
 * its instant. A manual run before the instant stamps an earlier
 * `lastRunAt`, which does not make the reminder sent.
 */
export function oneShotSent(routine: Pick<RoutineDto, "schedule" | "enabled" | "lastRunAt">): boolean {
  const once = oneShotTime(routine.schedule);
  if (!once || routine.enabled || routine.lastRunAt === null) return false;
  return new Date(routine.lastRunAt).getTime() >= once.getTime();
}

/** A paused one-shot whose instant passed unsent: switching it on sends it at once. */
export function oneShotOverdue(
  routine: Pick<RoutineDto, "schedule" | "enabled" | "lastRunAt">,
  now: Date,
): boolean {
  const once = oneShotTime(routine.schedule);
  if (!once || routine.enabled || once.getTime() > now.getTime()) return false;
  return !oneShotSent(routine);
}

export type RoutineFormValues = { name: string; message: string; schedule: string; timezone: string };

/**
 * What an edit sends: the changed fields only, so the API keeps the pending
 * occurrence of a rename or a new message (only schedule, zone or on/off
 * move the clock). A one-shot keeps its instant: the form cannot write one.
 */
export function routinePatch(
  routine: Pick<RoutineDto, "name" | "message" | "schedule" | "timezone">,
  values: RoutineFormValues,
): UpdateRoutineInput {
  const patch: UpdateRoutineInput = {};
  const name = values.name.trim();
  const message = values.message.trim();
  if (name !== routine.name) patch.name = name;
  if (message !== routine.message) patch.message = message;
  if (oneShotTime(routine.schedule) === null) {
    if (values.schedule !== routine.schedule) patch.schedule = values.schedule;
    if (values.timezone !== routine.timezone) patch.timezone = values.timezone;
  }
  return patch;
}
