/**
 * Routines : des tâches récurrentes par bot (Hermes « Routines pane »).
 *
 * La planification est un cron 5 champs (minute heure jour-du-mois mois
 * jour-de-semaine) évalué dans le FUSEAU de la routine : « tous les jours à
 * 9h » veut dire 9h chez l'opérateur, pas 9h UTC. Ce module est pur : il parse,
 * valide et calcule la prochaine occurrence ; la base et le worker vivent
 * ailleurs.
 *
 * Conversion fuseau sans bibliothèque : l'horloge murale d'un instant se lit
 * via `Intl`, et l'instant d'une horloge murale se retrouve en deux passes
 * d'offset. Aux bascules d'heure d'été l'occurrence peut glisser d'une heure,
 * recalculée à chaque tir, elle se recale d'elle-même au tir suivant.
 */

export const ROUTINE_LIMITS = {
  maxPerBot: 20,
  maxPerGroup: 20,
  nameMax: 100,
  messageMax: 4000,
  /** Occurrences sautées comptées au réveil, au-delà on arrête de compter. */
  maxMissedCounted: 24,
  /** Reports +60 s d'un fil occupé avant de passer à l'occurrence suivante. */
  maxBusyRetries: 10,
  /**
   * Un rappel ponctuel n'a pas d'occurrence suivante : l'abandonner au bout de
   * 10 min le perdrait. Au-delà des `maxBusyRetries` premiers reports, il se
   * reporte toutes les `oneShotSlowRetrySeconds`, environ une journée en tout.
   */
  maxOneShotBusyRetries: 10 + 24 * 6,
  oneShotSlowRetrySeconds: 600,
  /** Tirs qui lèvent d'affilée (reportés de 60 s) avant d'abandonner l'occurrence. */
  maxFireFailures: 10,
} as const;

export const ROUTINE_BUSY_RETRIES_EXHAUSTED_MESSAGE =
  "Fil occupé : 10 reports de 60 s épuisés, occurrence abandonnée.";
export const ROUTINE_ONE_SHOT_BUSY_RETRIES_EXHAUSTED_MESSAGE =
  "Fil occupé depuis environ 24 h : rappel abandonné, replanifiez-le à une nouvelle date.";
export const ROUTINE_FIRE_FAILED_MESSAGE =
  "Le tir de la routine a échoué : nouvel essai dans 60 s.";
export const ROUTINE_FIRE_FAILED_ABANDONED_MESSAGE =
  "Le tir de la routine a échoué 10 fois de suite : occurrence abandonnée.";
export const ROUTINE_GROUP_EMPTY_MESSAGE =
  "Ce groupe n'a plus de membre actif.";

export type CronFields = {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  /** `*` littéral : porte la règle cron : dom et dow restreints ensemble se lisent en OU. */
  domStar: boolean;
  dowStar: boolean;
};

type FieldSpec = { min: number; max: number; wrapSeven?: boolean };

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7, wrapSeven: true }, // day of week, 7 est un alias de 0 (dimanche)
];

function parseField(raw: string, spec: FieldSpec): Set<number> | null {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (!part) return null;
    const [rangeRaw, stepRaw, ...extra] = part.split("/");
    if (extra.length > 0 || stepRaw === "") return null;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (rangeRaw === "*") {
      from = spec.min;
      to = spec.max;
    } else if (/^\d+$/.test(rangeRaw ?? "")) {
      from = Number(rangeRaw);
      // `5/2` n'existe pas en cron : un pas exige `*` ou une plage.
      if (stepRaw !== undefined) return null;
      to = from;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(rangeRaw ?? "");
      if (!match) return null;
      from = Number(match[1]);
      to = Number(match[2]);
      if (from > to) return null;
    }
    if (from < spec.min || to > spec.max) return null;
    for (let value = from; value <= to; value += step) {
      values.add(spec.wrapSeven && value === 7 ? 0 : value);
    }
  }
  return values.size ? values : null;
}

/** `null` quand l'expression n'est pas un cron 5 champs valide. */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((part, index) => parseField(part, FIELDS[index]!));
  if (sets.some((set) => set === null)) return null;
  const [minute, hour, dom, month, dow] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return {
    minute, hour, dom, month, dow,
    domStar: parts[2] === "*",
    dowStar: parts[4] === "*",
  };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

/** An absolute one-shot instant; canonical UTC avoids ambiguous local/DST times. */
export function oneShotTime(expression: string): Date | null {
  const match = /^at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/.exec(expression.trim());
  if (!match) return null;
  const instant = new Date(match[1]!);
  if (!Number.isFinite(instant.getTime())) return null;
  const canonical = instant.toISOString();
  return canonical === match[1] || canonical.replace(".000Z", "Z") === match[1] ? instant : null;
}

export function isValidRoutineSchedule(expression: string): boolean {
  return oneShotTime(expression) !== null || isValidCron(expression);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  // `hour12: false` peut rendre « 24 » à minuit selon l'implémentation.
  return {
    year: read("year"), month: read("month"), day: read("day"),
    hour: read("hour") % 24, minute: read("minute"),
  };
}

/** Offset du fuseau à cet instant, en minutes (UTC+2 → 120). */
function offsetMinutes(instant: Date, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** L'instant UTC d'une horloge murale du fuseau : deux passes d'offset. */
function instantOf(wall: WallClock, timeZone: string): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = offsetMinutes(new Date(naive), timeZone);
  const guess = new Date(naive - first * 60_000);
  const second = offsetMinutes(guess, timeZone);
  return new Date(naive - second * 60_000);
}

/**
 * The instant of a wall-clock `YYYY-MM-DDTHH:mm` read in `timeZone`, or
 * `null` when the text, the date or the zone is not valid, or when that time
 * does not exist there (the clocks skip it, spring forward): a reminder is
 * never moved to an hour nobody asked for, the caller asks for another one.
 * A time that happens twice (fall back) is the first of the two.
 */
export function localWallClockInstant(local: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match || !isValidTimeZone(timeZone)) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59) return null;
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Every offset the zone uses around that day; each one that reads back the
  // same wall clock is a real instant of it.
  const offsets = new Set([-24, -12, 0, 12, 24].map((hours) => offsetMinutes(new Date(naive + hours * 3_600_000), timeZone)));
  const instants = [...offsets]
    .map((offset) => new Date(naive - offset * 60_000))
    .filter((instant) => {
      const wall = wallClockAt(instant, timeZone);
      return wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute;
    })
    .sort((left, right) => left.getTime() - right.getTime());
  return instants[0] ?? null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Jour de semaine (0 = dimanche) d'une date murale : indépendant du fuseau. */
function wallDow(wall: WallClock): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

function dayMatches(fields: CronFields, wall: WallClock): boolean {
  const domHit = fields.dom.has(wall.day);
  const dowHit = fields.dow.has(wallDow(wall));
  // Règle cron : les deux champs restreints se lisent en OU ; sinon en ET
  // (un `*` matche toujours, l'autre décide).
  if (!fields.domStar && !fields.dowStar) return domHit || dowHit;
  return domHit && dowHit;
}

/**
 * La prochaine occurrence STRICTEMENT après `from`, en UTC. `null` si
 * l'expression est invalide ou ne matche jamais dans les 5 prochaines années
 * (`0 0 31 2 *`).
 */
export function nextOccurrence(expression: string, from: Date, timeZone: string): Date | null {
  if (!isValidTimeZone(timeZone)) return null;
  const once = oneShotTime(expression);
  if (once) return once.getTime() > from.getTime() ? once : null;
  const fields = parseCron(expression);
  if (!fields) return null;

  // Départ : la minute murale suivante.
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const wall = wallClockAt(start, timeZone);
  const limitYear = wall.year + 5;

  // Sauts par champ, de l'extérieur vers l'intérieur : au pire quelques
  // milliers d'itérations (jours), jamais du minute-par-minute sur des années.
  for (let guard = 0; guard < 200_000; guard += 1) {
    if (wall.year > limitYear) return null;
    if (!fields.month.has(wall.month)) {
      wall.month += 1;
      if (wall.month > 12) { wall.month = 1; wall.year += 1; }
      wall.day = 1; wall.hour = 0; wall.minute = 0;
      continue;
    }
    if (wall.day > daysInMonth(wall.year, wall.month) || !dayMatches(fields, wall)) {
      wall.day += 1; wall.hour = 0; wall.minute = 0;
      if (wall.day > daysInMonth(wall.year, wall.month)) {
        wall.day = 1; wall.month += 1;
        if (wall.month > 12) { wall.month = 1; wall.year += 1; }
      }
      continue;
    }
    if (!fields.hour.has(wall.hour)) {
      wall.hour += 1; wall.minute = 0;
      if (wall.hour > 23) { wall.hour = 0; wall.day += 1; }
      continue;
    }
    if (!fields.minute.has(wall.minute)) {
      wall.minute += 1;
      if (wall.minute > 59) { wall.minute = 0; wall.hour += 1; }
      continue;
    }
    const instant = instantOf(wall, timeZone);
    // Invariant « strictement après `from` » : une bascule DST peut recaler
    // l'horloge murale sur un instant déjà passé (trou de printemps, recul
    // d'automne). On avance d'une minute murale plutôt que de rendre tôt.
    if (instant.getTime() > from.getTime()) return instant;
    wall.minute += 1;
    if (wall.minute > 59) { wall.minute = 0; wall.hour += 1; }
  }
  return null;
}

/**
 * Occurrences strictement après `dueAt` et ≤ `now` : celles que le tick
 * unique au réveil ne tirera pas. Plafonné : un cron à la minute éteint
 * six heures ne doit pas marcher 360 fois.
 */
export function countMissedOccurrences(
  expression: string,
  dueAt: Date,
  now: Date,
  timeZone: string,
  max: number = ROUTINE_LIMITS.maxMissedCounted,
): number {
  if (!(max > 0) || now.getTime() <= dueAt.getTime()) return 0;
  let cursor = dueAt;
  let missed = 0;
  while (missed < max) {
    const next = nextOccurrence(expression, cursor, timeZone);
    if (next === null || next.getTime() > now.getTime()) break;
    missed += 1;
    cursor = next;
  }
  return missed;
}

export type RoutineClock = { schedule: string; timezone: string; enabled: boolean };

export type EditedRoutineClock =
  | { kind: "unchanged" }
  | { kind: "rescheduled"; nextRunAt: Date | null }
  | { kind: "no_occurrence" };

/**
 * What an edit does to the clock. A rename or a new message leaves it alone:
 * a pending occurrence (deferred, waiting for its host) and its retries stay.
 * A real change (schedule, timezone, on/off) starts from the latest of `now`
 * and what the tick last handled (`lastRunAt`, `lastMissedAt`, written by the
 * database's clock), so an occurrence already fired or abandoned is never
 * re-armed, whatever the API's clock says. One exception: switching back on a
 * one-shot whose instant has passed without it ever firing re-arms it at
 * `now`; a reminder paused while it waited is not lost.
 */
export function editedRoutineClock(
  current: RoutineClock & { lastRunAt: Date | null; lastMissedAt: Date | null },
  next: RoutineClock,
  now: Date,
): EditedRoutineClock {
  if (next.schedule === current.schedule && next.timezone === current.timezone && next.enabled === current.enabled) {
    return { kind: "unchanged" };
  }
  if (!next.enabled) return { kind: "rescheduled", nextRunAt: null };
  const once = oneShotTime(next.schedule);
  const resumedOnly = next.schedule === current.schedule && next.timezone === current.timezone;
  if (once && resumedOnly && once.getTime() <= now.getTime()
    && (current.lastRunAt === null || current.lastRunAt.getTime() < once.getTime())) {
    return { kind: "rescheduled", nextRunAt: now };
  }
  const anchor = [current.lastRunAt, current.lastMissedAt].reduce<Date>(
    (latest, instant) => (instant && instant.getTime() > latest.getTime() ? instant : latest),
    now,
  );
  const nextRunAt = nextOccurrence(next.schedule, anchor, next.timezone);
  return nextRunAt ? { kind: "rescheduled", nextRunAt } : { kind: "no_occurrence" };
}

/**
 * Le texte que le tir d'une routine poste dans le fil du bot : visible de
 * l'opérateur ET du bot, qui sait ainsi pourquoi il parle sans qu'on ait posé
 * de canal caché.
 */
export function routineFireText(name: string, message: string): string {
  return `[Routine « ${name} »] ${message}`;
}
