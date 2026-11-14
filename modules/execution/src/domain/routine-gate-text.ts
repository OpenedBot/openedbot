/**
 * The sentence that says what a `routine_manage` approval gate is about to
 * do (`routineGateView`), in a reader's language. Built once, by the API, from
 * the platform's own reading of the call: it is the gate's `detail` for every
 * client (the console, the phone, the inbox) and the decisions journal, and
 * the reviewer reads it in English.
 *
 * Everything the bot or a person wrote (a name, the message) arrives already
 * made safe by `gateDataText` and is only ever placed between the product's
 * quote marks (`named`, `message` in `@openedbot/contracts-i18n/server`), never part of the
 * sentence's grammar.
 */
import type { RoutineGateDto, RoutineGateIssue, RoutineGatePromptDto, RoutineGateScheduleDto } from "@openedbot/contracts-api";
import type { RoutineGateMessageKey } from "@openedbot/contracts-i18n/server";
import { draftFromCron, scheduleText, type TextFormat } from "./routine-schedule-text";
import { ROUTINE_TOOL_MIN_INTERVAL_MINUTES } from "./routine-tool";
import { ROUTINE_LIMITS } from "./routines";

const ISSUES: Record<RoutineGateIssue, RoutineGateMessageKey> = {
  timezone_missing: "issueTimezoneMissing",
  timezone_invalid: "issueTimezoneInvalid",
  too_frequent: "issueTooFrequent",
  past_instant: "issuePastInstant",
  name_too_long: "issueNameTooLong",
  schedule_too_long: "issueScheduleTooLong",
  prompt_too_long: "issuePromptTooLong",
};

const TARGET_ACTIONS: Record<"pause" | "resume" | "remove", RoutineGateMessageKey> = {
  pause: "pause",
  resume: "resume",
  remove: "remove",
};

function delayText(seconds: number, format: TextFormat): string {
  const [value, unit] = seconds % 3600 === 0 ? [seconds / 3600, "hour"] : seconds % 60 === 0 ? [seconds / 60, "minute"] : [seconds, "second"];
  return format.formatNumber(value as number, { style: "unit", unit: unit as string, unitDisplay: "long" });
}

/** The schedule's translator and formats, and the gate's own server-side strings (`@openedbot/contracts-i18n/server`). */
export type GateTextFormat = TextFormat & { gate: (key: RoutineGateMessageKey, params?: Record<string, string | number>) => string };

/**
 * `viewerZone`: the zone a UTC instant is shown in when the call names none
 * (`UTC` on the server); the sentence always names the zone it uses.
 */
export function routineGateSentence(view: RoutineGateDto | null, format: GateTextFormat, viewerZone: string): string {
  const t = format.gate;
  if (!view) return t("undescribed");
  if (view.action === "list") return t("list");
  const words = scheduleText(format);
  const named = (name: string) => t("named", { name });
  const target = (routine: string | null) => (routine === null ? t("unknown") : named(routine));
  const sentences = (...parts: Array<string | null>) => parts.filter((part): part is string => part !== null).join(" ");
  const unattended = (flag: boolean | null) => (flag ? t("unattended") : null);
  if (view.action === "pause" || view.action === "remove") return t(TARGET_ACTIONS[view.action], { routine: target(view.routine) });
  if (view.action === "resume") return sentences(t(TARGET_ACTIONS.resume, { routine: target(view.routine) }), unattended(view.unattended));
  const call: Extract<RoutineGateDto, { action: "create" | "update" }> = view;
  const schedule = (value: RoutineGateScheduleDto): string => {
    if (value.kind === "delay") return t("delay", { delay: delayText(value.seconds, format) });
    if (value.kind === "unreadable") return t("scheduleUnreadable", { text: value.text });
    if (value.kind === "once") return words.describeInZone(`at ${value.at}`, call.timezone ?? viewerZone);
    // A schedule that only says minutes means the same in every zone.
    return call.timezone ? words.describeInZone(value.cron, call.timezone) : words.describeDraft(draftFromCron(value.cron));
  };
  const message = (prompt: RoutineGatePromptDto): string => prompt.excerpt === null
    // Approving this gate approves a message nobody here could read: said, not hidden.
    ? t("messageUnseen", { chars: prompt.chars })
    : t("message", { message: prompt.excerpt, chars: prompt.chars });
  const issue = call.issue
    ? t(ISSUES[call.issue], { minutes: ROUTINE_TOOL_MIN_INTERVAL_MINUTES, nameMax: ROUTINE_LIMITS.nameMax, messageMax: ROUTINE_LIMITS.messageMax })
    : null;
  if (call.action === "create") {
    const once = call.schedule.kind === "delay" || call.schedule.kind === "once";
    return sentences(
      t(once ? "createOnce" : "create", { name: named(call.name), schedule: schedule(call.schedule) }),
      message(call.prompt),
      // A routine the bot creates is active at once and never waits for a person (`routine-tool-routes.ts`).
      t("unattendedCreated"),
      issue,
    );
  }
  const changes = [
    call.name ? t("changeName", { name: named(call.name) }) : null,
    call.schedule ? t("changeSchedule", { schedule: schedule(call.schedule) }) : null,
    !call.schedule && call.timezone ? t("changeTimezone", { timezone: call.timezone }) : null,
  ].filter((change): change is string => change !== null);
  return sentences(
    t("update", {
      routine: target(call.routine),
      changes: changes.length > 0 || call.prompt ? changes.join(t("changeSeparator")) || t("changeMessageOnly") : t("changeNothing"),
    }),
    call.prompt ? message(call.prompt) : null,
    unattended(call.unattended),
    issue,
  );
}
