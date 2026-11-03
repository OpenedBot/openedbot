import { COLORS, SHAPES, defaultFaceFor, type BotFaceSpec } from "@openedbot/contracts-api";
import { parseCron } from "@openedbot/execution/domain/routines";

const SHAPE_ALIASES: Record<string, string> = {
  circle: "cercle",
  cercle: "cercle",
  pebble: "galet",
  galet: "galet",
  blob: "galet",
  squircle: "squircle",
  capsule: "capsule",
  pill: "capsule",
  triangle: "triangle",
  hexagon: "hexagone",
  hexagone: "hexagone",
  cloud: "nuage",
  nuage: "nuage",
  drop: "goutte",
  droplet: "goutte",
  goutte: "goutte",
};

const COLOR_ALIASES: Record<string, string> = {
  ink: "encre",
  encre: "encre",
  cream: "creme",
  creme: "creme",
  brown: "brun",
  brun: "brun",
  red: "rouge",
  rouge: "rouge",
  orange: "orange",
  amber: "ambre",
  ambre: "ambre",
  yellow: "ambre",
  green: "vert",
  vert: "vert",
  turquoise: "turquoise",
  teal: "turquoise",
  blue: "bleu",
  bleu: "bleu",
  violet: "violet",
  purple: "violet",
  pink: "rose",
  rose: "rose",
  gray: "gris",
  grey: "gris",
  gris: "gris",
};

export type HermesScheduleKind = "cron" | "every" | "once" | "ambiguous" | "other";

/** Only exactly representable intervals are anchored to the openedbot UTC clock. */
export function classifyHermesSchedule(raw: string): { kind: HermesScheduleKind; cron: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "other", cron: null };
  if (parseCron(trimmed)) return { kind: "cron", cron: trimmed };
  const interval = /^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days)$/i.exec(trimmed);
  if (interval) {
    const amount = Number(interval[1]);
    const unit = interval[2]!.toLowerCase()[0];
    const minutes = amount * (unit === "d" ? 1440 : unit === "h" ? 60 : 1);
    let cron: string | null = null;
    if (Number.isSafeInteger(minutes) && minutes > 0) {
      if (minutes < 60 && 60 % minutes === 0) cron = `*/${minutes} * * * *`;
      else if (minutes < 1440 && minutes % 60 === 0 && 24 % (minutes / 60) === 0) {
        cron = minutes === 60 ? "0 * * * *" : `0 */${minutes / 60} * * *`;
      } else if (minutes === 1440) cron = "0 0 * * *";
    }
    return { kind: "every", cron };
  }
  if (/^(once(?:\s|$)|in\s+\d)/i.test(trimmed)) return { kind: "once", cron: null };
  // Bare durations changed meaning between Hermes releases; never guess.
  if (/^\d+\s*(m|min|mins|minutes?|h|hr|hours?|d|days?)$/i.test(trimmed)) return { kind: "ambiguous", cron: null };
  return { kind: "other", cron: null };
}

export function scheduleLimitation(kind: HermesScheduleKind, slug: string, schedule: string): string | null {
  if (kind === "cron") return null;
  if (kind === "every") return `routine-schedule-every:${slug}:${schedule}`;
  if (kind === "once") return `routine-schedule-once:${slug}:${schedule}`;
  if (kind === "ambiguous") return `routine-schedule-ambiguous:${slug}:${schedule}`;
  return `routine-schedule-unsupported:${slug}:${schedule}`;
}

function mapShape(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const aliased = SHAPE_ALIASES[key];
  if (aliased && SHAPES.some((shape) => shape.id === aliased)) return aliased;
  if (SHAPES.some((shape) => shape.id === key)) return key;
  return null;
}

function parseHex(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1]!;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function mapColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  const aliased = COLOR_ALIASES[key];
  if (aliased) return aliased;
  if (COLORS.some((color) => color.id === key)) return key;
  const rgb = parseHex(raw);
  if (!rgb) return null;
  let best = COLORS[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const color of COLORS) {
    const other = parseHex(color.hex);
    if (!other) continue;
    const distance = (rgb[0] - other[0]) ** 2 + (rgb[1] - other[1]) ** 2 + (rgb[2] - other[2]) ** 2;
    if (distance < bestDistance) {
      best = color;
      bestDistance = distance;
    }
  }
  return best.id;
}

/**
 * `shape` / `color` amont (`ui_meta['hermes-bots']`) vers `BotFaceSpec`.
 * Un identifiant inconnu retombe sur le visage dérivé de la graine.
 */
export function mapHermesFace(input: {
  color?: string | null;
  shape?: string | null;
  seed: string;
  artwork?: string;
}): BotFaceSpec {
  const fallback = defaultFaceFor(input.seed);
  return {
    palette: mapColor(input.color) ?? fallback.palette,
    shape: mapShape(input.shape) ?? fallback.shape,
    eyes: fallback.eyes,
    ...(input.artwork ? { artwork: input.artwork } : {}),
  };
}
