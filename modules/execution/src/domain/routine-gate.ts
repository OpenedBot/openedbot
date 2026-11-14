/**
 * What an approval gate of `routine_manage` is about to do (DEV-209).
 *
 * The host plugin puts an MCP call's arguments in the gate descriptor
 * (`gate-identity.ts`). For openedbot's own tools they carry `run_key`, the
 * secret that names the live run to the API: `platformToolArguments` keeps
 * only each tool's own fields, when the gate is read, before anything is
 * stored, shown or sent to the reviewer (0188 scrubbed the rows written
 * before).
 *
 * `routineGateView` then reads those arguments the way the tool will
 * (`normalizeRoutineSchedule`, `routineScheduleNeedsTimezone`), so the card,
 * the dock and the reviewer describe the call that will really run. What the
 * bot or a person wrote (a name, the message, a schedule the tool cannot
 * read) stays data: `gateDataText` strips what could hide or reorder text and
 * the quote marks that could close its quotation, and bounds it.
 */
import type { RoutineGateDto, RoutineGateIssue, RoutineGatePromptDto, RoutineGateScheduleDto } from "@openedbot/contracts-api";
import { BOT_SETTINGS_TOOL_NAME, BOT_SETTINGS_TOOL_SERVER } from "./bot-settings-tool";
import {
  LOCAL_ONE_SHOT,
  ROUTINE_TOOL_ACTIONS,
  ROUTINE_TOOL_KEY,
  normalizeRoutineSchedule,
  routineRelativeDelayMs,
  routineScheduleNeedsTimezone,
  scheduleRespectsMinimumInterval,
  type RoutineToolAction,
} from "./routine-tool";
import { isValidTimeZone, localWallClockInstant, oneShotTime, ROUTINE_LIMITS } from "./routines";

const BOT_SETTINGS_TOOL_KEY = `mcp:${BOT_SETTINGS_TOOL_SERVER}:${BOT_SETTINGS_TOOL_NAME}`;
const ROUTINE_FIELDS = ["action", "job_id", "name", "prompt", "schedule", "timezone"] as const;
/** `bot-settings-tool.ts` `ALLOWED_KEYS`, without the run key. */
const BOT_SETTINGS_FIELDS = ["reason", "instructions", "label", "reply_language", "notify_on_finish"] as const;
/** The tool's own limits (`readRoutineToolArgs`). */
const SCHEDULE_MAX_CHARS = 100;
const TIMEZONE_MAX_CHARS = 64;
/** What a card shows of the message; its full length is always given. */
export const ROUTINE_GATE_PROMPT_EXCERPT_CHARS = 280;
const NAME_SHOWN_CHARS = ROUTINE_LIMITS.nameMax;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function keep(args: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const field of fields) if (Object.hasOwn(args, field)) kept[field] = args[field];
  return kept;
}

/**
 * The descriptor arguments of an openedbot tool, its schema's fields only:
 * never its run key. `routine_manage` also keeps `prompt_chars`, which a host
 * that left a long `prompt` out of the descriptor puts in its place. Any
 * other tool's arguments as the host described them.
 */
export function platformToolArguments(toolKey: string, value: unknown): unknown {
  const args = record(value);
  if (!args) return value;
  if (toolKey === ROUTINE_TOOL_KEY) {
    const kept = keep(args, ROUTINE_FIELDS);
    for (const field of ROUTINE_FIELDS) if (typeof kept[field] !== "string") delete kept[field];
    if (Number.isSafeInteger(args.prompt_chars) && (args.prompt_chars as number) >= 0) kept.prompt_chars = args.prompt_chars;
    return kept;
  }
  if (toolKey === BOT_SETTINGS_TOOL_KEY) return keep(args, BOT_SETTINGS_FIELDS);
  return value;
}

/**
 * Control and format characters (bidi overrides, zero-width spaces, line and
 * paragraph separators), except the zero-width joiner that composes emoji.
 */
const HIDDEN = /(?!\u200d)[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** Every double quote mark a sentence quotes with, in the product's languages and beyond. */
const QUOTES = /["«»“”„‟‹›〝〞〟＂]/g;

/** Length in Unicode code points: the unit the host counts `prompt_chars` in. */
export function codePoints(value: string): number {
  return [...value].length;
}

/**
 * Text the bot or a person wrote, made safe to quote inside the platform's
 * sentence: one line, nothing invisible, no quote mark of its own, at most
 * `max` code points.
 */
export function gateDataText(value: string, max: number): string {
  // Whitespace first: a line break is a control character, but it separates words.
  const line = value.replace(/\s+/g, " ").replace(HIDDEN, "").replace(QUOTES, "'").replace(/ {2,}/g, " ").trim();
  const points = [...line];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : line;
}

function readSchedule(raw: string, timezone: string | null, now: Date): RoutineGateScheduleDto {
  const text = raw.replace(/\s+/g, " ");
  const unreadable: RoutineGateScheduleDto = { kind: "unreadable", text: gateDataText(text, SCHEDULE_MAX_CHARS) };
  const once = oneShotTime(text);
  if (once) return { kind: "once", at: once.toISOString(), local: false };
  const local = LOCAL_ONE_SHOT.exec(text);
  if (local) {
    const instant = timezone ? localWallClockInstant(local[1]!, timezone) : null;
    return instant ? { kind: "once", at: instant.toISOString(), local: true } : unreadable;
  }
  const delay = routineRelativeDelayMs(text.toLowerCase());
  if (delay !== undefined) return delay === null ? unreadable : { kind: "delay", seconds: Math.round(delay / 1000) };
  const cron = normalizeRoutineSchedule(text, now, timezone);
  return cron && !cron.startsWith("at ") ? { kind: "recurring", cron } : unreadable;
}

type ScheduleFacts = { raw: string | null; schedule: RoutineGateScheduleDto | null; timezoneGiven: string | null; timezone: string | null };

/** The first refusal the tool will answer for this call as stated, if any (`routine-tool-routes.ts`). */
function callIssue(name: string | null, prompt: RoutineGatePromptDto | null, promptUnits: number | null, facts: ScheduleFacts, now: Date): RoutineGateIssue | null {
  if (name !== null && name.length > ROUTINE_LIMITS.nameMax) return "name_too_long";
  // The tool counts UTF-16 units; a host that left the prompt out counted code points, never more.
  if ((promptUnits ?? 0) > ROUTINE_LIMITS.messageMax || (prompt !== null && prompt.chars > ROUTINE_LIMITS.messageMax)) return "prompt_too_long";
  if (facts.raw !== null && facts.raw.length > SCHEDULE_MAX_CHARS) return "schedule_too_long";
  if (facts.timezoneGiven && !facts.timezone) return "timezone_invalid";
  if (facts.raw && !facts.timezone && routineScheduleNeedsTimezone(facts.raw)) return "timezone_missing";
  if (facts.schedule?.kind === "once" && new Date(facts.schedule.at).getTime() <= now.getTime()) return "past_instant";
  if (facts.schedule?.kind === "recurring" && !scheduleRespectsMinimumInterval(facts.schedule.cron, facts.timezone ?? "UTC", now)) return "too_frequent";
  return null;
}

/** The routine a gate's `job_id` names among the bot's own, as stored now. */
export type RoutineGateTarget = { name: string; neverWait: boolean };

/**
 * The call a `routine_manage` gate would let through, or `null` when its
 * arguments cannot say it (absent, or a call the tool refuses outright).
 * `target`: the routine `job_id` points to among the bot's, `null` when it is
 * none of them.
 */
export function routineGateView(argumentsValue: unknown, target: RoutineGateTarget | null, now: Date): RoutineGateDto | null {
  const args = record(argumentsValue);
  if (!args || typeof args.action !== "string" || !(ROUTINE_TOOL_ACTIONS as readonly string[]).includes(args.action)) return null;
  const action = args.action as RoutineToolAction;
  const text = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  if (action === "list") return { action };
  const routine = target === null ? null : gateDataText(target.name, NAME_SHOWN_CHARS);
  const unattended = target === null ? null : target.neverWait;
  if (action === "pause" || action === "remove") return { action, routine };
  if (action === "resume") return { action, routine, unattended };

  const timezoneGiven = text("timezone");
  const timezone = timezoneGiven && timezoneGiven.length <= TIMEZONE_MAX_CHARS && isValidTimeZone(timezoneGiven) ? timezoneGiven : null;
  const raw = text("schedule");
  const schedule = raw ? readSchedule(raw, timezone, now) : null;
  const name = text("name");
  const promptText = text("prompt");
  const omitted = Number.isSafeInteger(args.prompt_chars) && (args.prompt_chars as number) > 0 ? args.prompt_chars as number : null;
  const prompt: RoutineGatePromptDto | null = promptText !== null
    ? { excerpt: gateDataText(promptText, ROUTINE_GATE_PROMPT_EXCERPT_CHARS), chars: codePoints(promptText) }
    : omitted !== null ? { excerpt: null, chars: omitted } : null;
  const issue = callIssue(name, prompt, promptText?.length ?? null, { raw, schedule, timezoneGiven, timezone }, now);
  const shownName = name === null ? null : gateDataText(name, NAME_SHOWN_CHARS);
  if (action === "create") {
    // The tool refuses a creation without them: nothing true to describe.
    if (!shownName || !schedule || !prompt) return null;
    return { action, name: shownName, schedule, timezone, prompt, issue };
  }
  return { action, routine, unattended, name: shownName, prompt, schedule, timezone, issue };
}
