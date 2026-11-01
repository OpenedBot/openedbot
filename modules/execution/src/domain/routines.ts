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
} as const;

export const ROUTINE_BUSY_RETRIES_EXHAUSTED_MESSAGE =
  "Fil occupé : 10 reports de 60 s épuisés, occurrence abandonnée.";
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
  const fields = parseCron(expression);
  if (!fields || !isValidTimeZone(timeZone)) return null;

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

/**
 * Le texte que le tir d'une routine poste dans le fil du bot : visible de
 * l'opérateur ET du bot, qui sait ainsi pourquoi il parle sans qu'on ait posé
 * de canal caché.
 */
export function routineFireText(name: string, message: string): string {
  return `[Routine « ${name} »] ${message}`;
}
