/**
 * `routine_manage` : l'outil par lequel un bot gère SES routines depuis la
 * conversation (DEV-209). Ce module est pur : le schéma vu par le
 * modèle, la lecture stricte de ses arguments et la normalisation de la
 * planification. L'écriture vit côté API, sur le chemin des routes Routines.
 *
 * Le schéma reprend `cronjob_manage` d'Hermes (`tools/cronjob_tools.py`) :
 * mêmes actions, mêmes noms de champs (`job_id`, `prompt`, `schedule`), pour
 * qu'un modèle entraîné sur l'un sache se servir de l'autre. Ce qui n'a pas de
 * sens ici est retiré : `deliver`, `skills`, `script`, `workdir` (une routine
 * répond déjà dans le fil du bot), et `run` (le bot fait le travail tout de
 * suite dans le run courant au lieu de s'envoyer un second run).
 */
import type { RoutineToolAvailability } from "@openedbot/roster/domain/routine-tool-rule";
import { RELAY_FEATURE_GATEWAY_RESTART, RELAY_FEATURE_MCP_LIVE_RELOAD, RELAY_FEATURE_MCP_MANAGEMENT, RELAY_FEATURE_PROFILE_CAPABILITIES } from "@openedbot/contracts-connector/features";
import { isValidCron, isValidTimeZone, localWallClockInstant, nextOccurrence, oneShotTime, ROUTINE_LIMITS } from "./routines";

export { ROUTINE_TOOL_KEY, ROUTINE_TOOL_NAME, ROUTINE_TOOL_RUNTIME_NAME, ROUTINE_TOOL_SERVER } from "./routine-tool-names";

/**
 * La clé de run, ajoutée À LA FIN de l'entrée d'un run dont le bot a l'outil :
 * l'entrée change à chaque run de toute façon, les instructions restent un
 * préfixe stable pour le cache du fournisseur. Le fil n'en garde rien : il
 * conserve le message de l'opérateur, pas l'entrée envoyée à Hermes.
 * The user's timezone travels on the same terms: `unknown` makes the bot ask
 * before it schedules a time of day.
 */
export function withRoutineRunKey(input: string, runKey: string, timezone: string | null): string {
  return `${input}\n\n[routine_manage run_key: ${runKey}]\n[routine_manage user timezone: ${timezone ?? "unknown"}]`;
}

/** Écart minimal entre deux tirs d'une routine créée par un bot. */
export const ROUTINE_TOOL_MIN_INTERVAL_MINUTES = 15;

export const ROUTINE_TOOL_ACTIONS = ["create", "list", "update", "pause", "resume", "remove"] as const;
export type RoutineToolAction = (typeof ROUTINE_TOOL_ACTIONS)[number];

/**
 * PERM2-9: the bot's permission to resume/remove routines through `routine_manage`.
 *   - `plan`: nothing is written (`refused`);
 *   - `auto` / `bypass`: a created routine is active, resume and remove are
 *     allowed (`active`);
 *   - `manual`, and any value this code does not know: resume and remove
 *     are refused (`paused`). Creation separately defaults to active for the
 *     supported writing modes, including manual; unknown modes stay paused.
 */
export type RoutineToolWriteRight = "refused" | "paused" | "active";

export function routineToolWriteRight(mode: string | null): RoutineToolWriteRight {
  if (mode === "plan") return "refused";
  if (mode === "auto" || mode === "bypass") return "active";
  return "paused";
}

export type RoutineToolArgs = {
  action: RoutineToolAction;
  runKey: string;
  jobId: string | null;
  name: string | null;
  prompt: string | null;
  schedule: string | null;
  timezone: string | null;
};

export const ROUTINE_TOOL_DESCRIPTION = [
  "Manage YOUR routines and one-shot reminders. Each sends you its prompt at the scheduled time, in this conversation, and you answer it then. New routines and reminders are active by default.",
  "`list` only reads: call it to find the `job_id` before `update`, `pause`, `resume` or `remove`, and never guess one. `create` needs no `list` first.",
  "Write `prompt` as a self-contained instruction to your future self (what to do and how to report), not as a message to the user. `list` shows only the start of each prompt (`prompt_excerpt`, with `prompt_chars`): to change a prompt, `update` it with the full new text.",
  "Prefer `update` over creating a near-duplicate of a routine the user refers to.",
  "For a one-shot reminder, use `in 2m`, `in 1h`, `at YYYY-MM-DDTHH:mm` (a local time, read in `timezone`) or `at YYYY-MM-DDTHH:mm:ssZ` (a UTC instant). It is scheduled once and then disables itself. For recurring routines use a 5-field cron (`0 9 * * 1-5`) or `hourly`, `every 2h`, `every 30m`, `daily at 9am`, `weekdays at 9:30`, `every monday at 8am`.",
  "`timezone` is an IANA name such as `Europe/Paris`, required for any time of day (recurring or local one-shot): nothing falls back to UTC. Relative delays like `in 2m` and UTC instants do not need one. Use the user's timezone from your instructions; when it is unknown, ask the user before creating.",
  "Always pass `run_key` exactly as given in your instructions.",
].join(" ");

export const ROUTINE_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ROUTINE_TOOL_ACTIONS], description: "What to do." },
    run_key: { type: "string", description: "The run key given in your instructions, copied exactly." },
    job_id: { type: "string", description: "The routine id, from `list`. Required except for create and list." },
    name: { type: "string", description: "Short routine name (create, update)." },
    prompt: { type: "string", description: "The instruction you will receive at each run (create, update)." },
    schedule: { type: "string", description: "When it runs (create, update)." },
    timezone: { type: "string", description: "IANA timezone of the schedule (create, update). Required for a time of day; never assumed." },
  },
  required: ["action", "run_key"],
  additionalProperties: false,
} as const;

export class RoutineToolInputError extends Error {}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new RoutineToolInputError(`${label} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new RoutineToolInputError(`${label} is longer than ${max} characters.`);
  return trimmed;
}

/** Lecture stricte des arguments d'un appel `tools/call`. */
export function readRoutineToolArgs(raw: unknown): RoutineToolArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RoutineToolInputError("arguments must be an object.");
  }
  const args = raw as Record<string, unknown>;
  const action = args.action;
  if (typeof action !== "string" || !(ROUTINE_TOOL_ACTIONS as readonly string[]).includes(action)) {
    throw new RoutineToolInputError(`action must be one of ${ROUTINE_TOOL_ACTIONS.join(", ")}.`);
  }
  const runKey = optionalText(args.run_key, "run_key", 200);
  if (!runKey) throw new RoutineToolInputError("run_key is required: copy it from your instructions.");
  const parsed: RoutineToolArgs = {
    action: action as RoutineToolAction,
    runKey,
    jobId: optionalText(args.job_id, "job_id", 64),
    name: optionalText(args.name, "name", ROUTINE_LIMITS.nameMax),
    prompt: optionalText(args.prompt, "prompt", ROUTINE_LIMITS.messageMax),
    schedule: optionalText(args.schedule, "schedule", 100),
    timezone: optionalText(args.timezone, "timezone", 64),
  };
  if (parsed.action === "create" && (!parsed.name || !parsed.prompt || !parsed.schedule)) {
    throw new RoutineToolInputError("create needs name, prompt and schedule.");
  }
  if (parsed.action !== "create" && parsed.action !== "list" && !parsed.jobId) {
    throw new RoutineToolInputError(`${parsed.action} needs job_id: call list first.`);
  }
  if (parsed.timezone && !isValidTimeZone(parsed.timezone)) {
    throw new RoutineToolInputError("timezone must be an IANA name such as Europe/Paris.");
  }
  return parsed;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** `9am`, `9:30am`, `21:00`, `9h`, `9h30` : heure et minute murales. */
function readClock(raw: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm|h)?$/.exec(raw.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const suffix = match[3];
  if (suffix === "am" || suffix === "pm") {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (suffix === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Une planification en cron 5 champs, depuis un cron ou une forme courante
 * (le sous-ensemble récurrent de `cron/jobs.py` d'Hermes). `null` si rien ne
 * correspond : l'outil répond alors avec les formes acceptées.
 */
export function normalizeRoutineSchedule(raw: string, now: Date = new Date(), timezone: string | null = null): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  const once = oneShotTime(text);
  if (once) return `at ${once.toISOString()}`;
  const local = LOCAL_ONE_SHOT.exec(text);
  if (local) {
    const instant = timezone ? localWallClockInstant(local[1]!, timezone) : null;
    return instant ? `at ${instant.toISOString()}` : null;
  }
  if (isValidCron(text)) return text;
  const lower = text.toLowerCase();
  const delay = routineRelativeDelayMs(lower);
  if (delay !== undefined) {
    const instant = delay === null ? null : new Date(now.getTime() + delay);
    return instant && Number.isFinite(instant.getTime()) ? `at ${instant.toISOString()}` : null;
  }
  if (lower === "hourly" || lower === "every hour") return "0 * * * *";
  let match = /^every (\d{1,2}) ?(h|hours?)$/.exec(lower);
  if (match) {
    const hours = Number(match[1]);
    return hours >= 1 && hours <= 12 ? (hours === 1 ? "0 * * * *" : `0 */${hours} * * *`) : null;
  }
  match = /^every (\d{1,2}) ?(m|min|mins|minutes?)$/.exec(lower);
  if (match) {
    const minutes = Number(match[1]);
    return minutes >= 1 && minutes <= 59 ? `*/${minutes} * * * *` : null;
  }
  match = /^(?:every day|daily|each day)(?: at)? (.+)$/.exec(lower);
  if (match) {
    const clock = readClock(match[1]!);
    return clock ? `${clock.minute} ${clock.hour} * * *` : null;
  }
  match = /^(?:every )?weekdays?(?: at)? (.+)$/.exec(lower);
  if (match) {
    const clock = readClock(match[1]!);
    return clock ? `${clock.minute} ${clock.hour} * * 1-5` : null;
  }
  match = /^(?:every|weekly on|each) ([a-z]+)(?: at)? (.+)$/.exec(lower);
  if (match && WEEKDAYS[match[1]!] !== undefined) {
    const clock = readClock(match[2]!);
    return clock ? `${clock.minute} ${clock.hour} * * ${WEEKDAYS[match[1]!]}` : null;
  }
  return null;
}

/**
 * The delay of `in 2m`, `dans 1 h`... in ms, counted from the moment the call
 * reaches the API (after any approval); `null` for a delay out of bounds,
 * `undefined` when `lower` (already lowercased) is not a relative delay.
 */
export function routineRelativeDelayMs(lower: string): number | null | undefined {
  const relative = /^(?:in|dans) (\d{1,6}) ?(s|sec|seconds?|secondes?|m|mn|min|mins|minutes?|h|hours?|heures?)$/.exec(lower);
  if (!relative) return undefined;
  const scale = /^(s|sec)/.test(relative[2]!) ? 1000 : /^(h|hour|heure)/.test(relative[2]!) ? 3_600_000 : 60_000;
  const delay = Number(relative[1]) * scale;
  return delay > 0 && delay <= 365 * 86_400_000 ? delay : null;
}

export const LOCAL_ONE_SHOT = /^at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/;
const RELATIVE_DELAY = /^(?:in|dans) \d/i;

/**
 * Whether `raw` names a time of day, which only means something in a
 * timezone: a local one-shot, or a recurring schedule that fixes an hour, a
 * day or a month. A relative delay, a UTC instant and a schedule that only
 * says minutes (`every 30m`, `hourly`) are the same everywhere.
 */
export function routineScheduleNeedsTimezone(raw: string): boolean {
  const text = raw.trim().replace(/\s+/g, " ");
  if (oneShotTime(text) || RELATIVE_DELAY.test(text)) return false;
  if (LOCAL_ONE_SHOT.test(text)) return true;
  // A schedule nobody understands is refused as such, not for its zone.
  const cron = normalizeRoutineSchedule(text);
  return cron !== null && !/^\S+ \* \* \* \*$/.test(cron);
}

/** Vrai si deux tirs successifs sont au moins à `minutes` d'écart. */
export function scheduleRespectsMinimumInterval(
  schedule: string,
  timezone: string,
  now: Date,
  minutes = ROUTINE_TOOL_MIN_INTERVAL_MINUTES,
): boolean {
  let previous = nextOccurrence(schedule, now, timezone);
  if (!previous) return false;
  // Quelques tirs suffisent à voir un cron serré (`*/5`, `0,5 9 * * *`).
  for (let index = 0; index < 6; index += 1) {
    const next = nextOccurrence(schedule, previous, timezone);
    if (!next) return true;
    if (next.getTime() - previous.getTime() < minutes * 60_000) return false;
    previous = next;
  }
  return true;
}

/**
 * Whether a host can carry the tool at all, read on the features its link
 * announced: the MCP verbs, the per-profile switch for a bot that has a
 * profile, and a way for openedbot to know when the gateway sees the server
 * (it reloads MCP by itself, or it reports a pending restart).
 */
export function hostCarriesRoutineTool(features: readonly string[], hasProfile: boolean): boolean {
  return features.includes(RELAY_FEATURE_MCP_MANAGEMENT)
    && (!hasProfile || features.includes(RELAY_FEATURE_PROFILE_CAPABILITIES))
    && (features.includes(RELAY_FEATURE_MCP_LIVE_RELOAD) || features.includes(RELAY_FEATURE_GATEWAY_RESTART));
}

/** The reasons that do not go away by waiting: the host or the API must change. */
const LASTING_BLOCKS: ReadonlySet<string> = new Set(["https_required", "runtime_required", "host_unsupported", "profile_unsupported"]);

/**
 * What a run of this bot may say about scheduling (`buildBotModeInstructions`).
 * `enabled` only when the host proved the tool on the bot's profile on the
 * runtime serving the run and the gateway has had the time to load it
 * (`ready`). The bot's own permission mode decides `plan_mode`: a plan-only
 * turn keeps the bot's block (cached prefix) and the tool refuses its writes.
 */
export function routineToolAvailability(input: {
  switchedOff: boolean;
  ready: boolean;
  blockedReason: string | null;
  /** `null` for a direct runtime: its link announces nothing. */
  linkFeatures: readonly string[] | null;
  hasProfile: boolean;
  botPermissionMode: string | null;
}): RoutineToolAvailability {
  if (input.switchedOff) return "switched_off";
  if (input.ready) return input.botPermissionMode === "plan" ? "plan_mode" : "enabled";
  if (input.blockedReason && LASTING_BLOCKS.has(input.blockedReason)) return "unavailable";
  if (input.linkFeatures && !hostCarriesRoutineTool(input.linkFeatures, input.hasProfile)) return "unavailable";
  return "not_ready";
}

/**
 * A routine `create` would duplicate. A model that cannot see its earlier
 * calls (the thread's history carries their text, not the calls) may create
 * the same routine again to make its own claim true: measured in production
 * on 2026-11-12, a « hello » created a second identical active routine.
 *
 * A twin is a routine of the same bot with the same schedule (both are stored
 * normalized, so `daily at 9am` and `0 9 * * *` are one), the same timezone
 * and the same name up to case and whitespace. The message is not compared:
 * the model rewrites it on each attempt (lab, 2026-11-13: « en une phrase
 * courte » then « en une phrase » for the same reminder), so an equal-message
 * rule let the duplicate through. The existing routine keeps its message; the
 * bot changes it with `update` if that was the point. A paused twin still
 * counts: the bot says it exists and is paused, it never creates a second
 * one. A one-shot whose instant has passed is no twin: it will not fire
 * again. The console's « Routines… » form does not go through here: a person
 * creating two alike routines by hand means it.
 */
export function routineCreateTwin<T extends { name: string; schedule: string; timezone: string }>(
  candidate: { name: string; schedule: string; timezone: string },
  existing: readonly T[],
  now: Date,
): T | null {
  const name = routineTextKey(candidate.name).toLowerCase();
  for (const routine of existing) {
    if (routine.schedule !== candidate.schedule || routine.timezone !== candidate.timezone) continue;
    if (routineTextKey(routine.name).toLowerCase() !== name) continue;
    if (oneShotTime(routine.schedule) !== null && nextOccurrence(routine.schedule, now, routine.timezone) === null) continue;
    return routine;
  }
  return null;
}

function routineTextKey(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}
