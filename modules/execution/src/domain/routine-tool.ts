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
import { isValidCron, isValidTimeZone, nextOccurrence, ROUTINE_LIMITS } from "./routines";

/** Nom du serveur MCP sur l'hôte : un par runtime, jamais un par bot. */
export const ROUTINE_TOOL_SERVER = "openedbot_routines";
export const ROUTINE_TOOL_NAME = "routine_manage";
/** Le nom que Hermes donne à l'outil dans un run (`mcp_<serveur>_<outil>`). */
export const ROUTINE_TOOL_RUNTIME_NAME = `mcp_${ROUTINE_TOOL_SERVER}_${ROUTINE_TOOL_NAME}`;
/**
 * La clé de run, ajoutée À LA FIN de l'entrée d'un run dont le bot a l'outil :
 * l'entrée change à chaque run de toute façon, les instructions restent un
 * préfixe stable pour le cache du fournisseur. Le fil n'en garde rien : il
 * conserve le message de l'opérateur, pas l'entrée envoyée à Hermes.
 */
export function withRoutineRunKey(input: string, runKey: string): string {
  return `${input}\n\n[routine_manage run_key: ${runKey}]`;
}

/** Écart minimal entre deux tirs d'une routine créée par un bot. */
export const ROUTINE_TOOL_MIN_INTERVAL_MINUTES = 15;

export const ROUTINE_TOOL_ACTIONS = ["create", "list", "update", "pause", "resume", "remove"] as const;
export type RoutineToolAction = (typeof ROUTINE_TOOL_ACTIONS)[number];

/**
 * PERM2-9: what the bot's stored permission mode lets `routine_manage` write.
 *   - `plan`: nothing is written (`refused`);
 *   - `auto` / `bypass`: a created routine is active, resume and remove are
 *     allowed (`active`);
 *   - `manual`, and any value this code does not know: a created routine is
 *     paused, resume and remove are refused (`paused`).
 * Each mode that activates is named: a mode added later stays paused until
 * someone decides otherwise here.
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
  "Manage YOUR recurring routines. A routine sends you its prompt at the scheduled times, in this conversation, and you answer it then.",
  "Always call `list` before `update`, `pause`, `resume` or `remove`, and never guess a `job_id`.",
  "Write `prompt` as a self-contained instruction to your future self (what to do and how to report), not as a message to the user.",
  "Prefer `update` over creating a near-duplicate.",
  "`schedule` is a 5-field cron (`0 9 * * 1-5`) or `hourly`, `every 2h`, `every 30m`, `daily at 9am`, `weekdays at 9:30`, `every monday at 8am`. One-shot schedules are not supported.",
  "`timezone` is an IANA name such as `Europe/Paris`; ask the user when you do not know it.",
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
    timezone: { type: "string", description: "IANA timezone of the schedule (create, update). Defaults to UTC." },
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
export function normalizeRoutineSchedule(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (isValidCron(text)) return text;
  const lower = text.toLowerCase();
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
