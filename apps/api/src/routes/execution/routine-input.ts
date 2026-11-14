import {
  ROUTINE_LIMITS,
  editedRoutineClock,
  isValidRoutineSchedule,
  isValidTimeZone,
  nextOccurrence,
  type RoutineClock,
} from "@openedbot/execution/domain/routines";
import { assertString, HttpError } from "../../interfaces/http/http-error";

const NO_OCCURRENCE = (): HttpError => new HttpError(
  400,
  "ROUTINE_SCHEDULE_NO_OCCURRENCE",
  "Cette planification ne possède aucune prochaine occurrence.",
);

/**
 * Validates and normalizes a routine's input: shared between POST (complete) and
 * PATCH (merged with the existing one before validation, so that the result is
 * ALWAYS entirely valid).
 */
export function validatedRoutineInput(body: Record<string, unknown>, options: { requireOccurrence?: boolean } = {}): {
  name: string;
  schedule: string;
  timezone: string;
  message: string;
  enabled: boolean;
  neverWait: boolean;
} {
  const name = assertString(body.name, "Le nom de la routine", { max: ROUTINE_LIMITS.nameMax });
  // A name is shown inside sentences (an approval, the list): nothing in it may
  // hide text or reorder it. The zero-width joiner stays, emoji need it.
  if (/(?!\u200d)[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)) {
    throw new HttpError(400, "ROUTINE_NAME_INVALID", "Le nom de la routine ne peut contenir ni retour à la ligne ni caractère invisible ou de contrôle.");
  }
  const schedule = assertString(body.schedule, "La planification", { max: 100 });
  if (!isValidRoutineSchedule(schedule)) {
    throw new HttpError(400, "ROUTINE_SCHEDULE_INVALID", "La planification doit être un cron à 5 champs ou un instant UTC « at YYYY-MM-DDTHH:mm:ssZ ».");
  }
  const timezone = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "UTC";
  if (!isValidTimeZone(timezone)) {
    throw new HttpError(400, "ROUTINE_TIMEZONE_INVALID", "Le fuseau doit être un identifiant IANA (ex. « Europe/Paris »).");
  }
  const message = assertString(body.message, "Le message de la routine", { max: ROUTINE_LIMITS.messageMax });
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  // An edit decides its occurrence from the clock it keeps (`editedClock`).
  if ((options.requireOccurrence ?? true) && enabled && nextOccurrence(schedule, new Date(), timezone) === null) {
    throw NO_OCCURRENCE();
  }
  // PERM2-9: absent is off (an operator's routine waits for a person, as
  // before); anything but a boolean is refused rather than guessed.
  if (body.neverWait !== undefined && typeof body.neverWait !== "boolean") {
    throw new HttpError(400, "ROUTINE_NEVER_WAIT_INVALID", "L’option « Ne jamais attendre » doit être vraie ou fausse.");
  }
  const neverWait = body.neverWait === true;
  return { name, schedule, timezone, message, enabled, neverWait };
}

/**
 * The clock an edit (PATCH, the bot's `routine_manage`) writes, from the row
 * read `for update`: `null` keeps `next_run_at` and `busy_retries` as they
 * are; otherwise the new `next_run_at`, with `busy_retries` reset.
 */
export function editedClock(
  current: RoutineClock & { lastRunAt: Date | string | null; lastMissedAt: Date | string | null },
  next: RoutineClock,
  now: Date,
): { nextRunAt: Date | null } | null {
  const asDate = (value: Date | string | null) => (value === null ? null : new Date(value));
  const clock = editedRoutineClock(
    { ...current, lastRunAt: asDate(current.lastRunAt), lastMissedAt: asDate(current.lastMissedAt) },
    next,
    now,
  );
  if (clock.kind === "no_occurrence") throw NO_OCCURRENCE();
  return clock.kind === "unchanged" ? null : { nextRunAt: clock.nextRunAt };
}
