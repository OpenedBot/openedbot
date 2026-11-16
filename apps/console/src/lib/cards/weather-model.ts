import type { WeatherCardData, WeatherDay } from "@openedbot/contracts-events";
import { zonedDayKey } from "./weather-time";

/**
 * Pure derivations of the weather card: units, the daily range bars and the
 * hourly strip. Inputs are the metric payload; nothing here formats text.
 */

export type TemperatureUnit = "celsius" | "fahrenheit";

const HOUR_MS = 3_600_000;
/** Hour columns of the default strip, « Maintenant » included. */
export const STRIP_HOURS = 24;
/** Day rows shown before « Afficher plus ». */
export const COLLAPSED_DAYS = 5;
/** Under this chance (rounded to a percent) the precipitation figure stays hidden. */
export const PRECIP_DISPLAY_MIN_PERCENT = 10;

/** `Math.round` that never yields `-0`: « -0° » is not a temperature. */
function roundInt(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

export function displayTemperature(celsius: number, unit: TemperatureUnit): number {
  return roundInt(unit === "fahrenheit" ? (celsius * 9) / 5 + 32 : celsius);
}

export function displayWind(kph: number, unit: TemperatureUnit): { value: number; unit: "kph" | "mph" } {
  return unit === "fahrenheit" ? { value: roundInt(kph / 1.609344), unit: "mph" } : { value: roundInt(kph), unit: "kph" };
}

export function precipPercent(chance: number): number {
  return Math.round(Math.min(1, Math.max(0, chance)) * 100);
}

export function showsPrecip(chance: number): boolean {
  return precipPercent(chance) >= PRECIP_DISPLAY_MIN_PERCENT;
}

export type TemperatureBounds = { lowC: number; highC: number };

/** One scale for every bar: the coldest minimum and the warmest maximum of the forecast. */
export function forecastBounds(days: readonly Pick<WeatherDay, "minC" | "maxC">[]): TemperatureBounds {
  let lowC = Number.POSITIVE_INFINITY;
  let highC = Number.NEGATIVE_INFINITY;
  for (const day of days) {
    lowC = Math.min(lowC, day.minC);
    highC = Math.max(highC, day.maxC);
  }
  return Number.isFinite(lowC) ? { lowC, highC } : { lowC: 0, highC: 0 };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Where a value sits on the scale, 0..1; a flat scale puts everything in the middle. */
export function scaleFraction(celsius: number, bounds: TemperatureBounds): number {
  const span = bounds.highC - bounds.lowC;
  return span <= 0 ? 0.5 : clamp01((celsius - bounds.lowC) / span);
}

/** The filled segment of a day: its min..max on the forecast's scale. */
export function rangeFractions(minC: number, maxC: number, bounds: TemperatureBounds): { start: number; end: number } {
  if (bounds.highC - bounds.lowC <= 0) return { start: 0, end: 1 };
  return { start: scaleFraction(minC, bounds), end: scaleFraction(maxC, bounds) };
}

/**
 * The absolute palette of the bars, in °C: the same temperature has the
 * same color on every row, whatever unit is displayed.
 */
export const TEMPERATURE_STOPS: readonly (readonly [number, readonly [number, number, number]])[] = [
  [0, [76, 125, 255]],
  [8, [34, 195, 230]],
  [14, [52, 199, 123]],
  [21, [243, 207, 58]],
  [27, [247, 146, 58]],
  [33, [239, 75, 75]],
];

function rgb([r, g, b]: readonly [number, number, number]): string {
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
}

/** The palette's color at a temperature, interpolated between stops and held beyond the ends. */
export function temperatureColor(celsius: number): string {
  const first = TEMPERATURE_STOPS[0]!;
  const last = TEMPERATURE_STOPS[TEMPERATURE_STOPS.length - 1]!;
  if (celsius <= first[0]) return rgb(first[1]);
  if (celsius >= last[0]) return rgb(last[1]);
  for (let index = 1; index < TEMPERATURE_STOPS.length; index += 1) {
    const [toC, to] = TEMPERATURE_STOPS[index]!;
    const [fromC, from] = TEMPERATURE_STOPS[index - 1]!;
    if (celsius > toC) continue;
    const t = (celsius - fromC) / (toC - fromC);
    return rgb([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t]);
  }
  return rgb(last[1]);
}

/**
 * The slice of the one global gradient that a min..max segment covers: the
 * segment's ends take the palette color of their temperature and every
 * palette stop inside sits at its own place, so two adjacent rows read as
 * cut from the same strip.
 */
export function gradientSlice(minC: number, maxC: number): string {
  if (maxC - minC <= 0) return temperatureColor(minC);
  const stops = [`${temperatureColor(minC)} 0%`];
  for (const [celsius] of TEMPERATURE_STOPS) {
    if (celsius <= minC || celsius >= maxC) continue;
    stops.push(`${temperatureColor(celsius)} ${roundPercent(((celsius - minC) / (maxC - minC)) * 100)}%`);
  }
  stops.push(`${temperatureColor(maxC)} 100%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

export type StripHourCell = {
  kind: "hour";
  key: string;
  startMs: number;
  isNow: boolean;
  conditionCode: string;
  daylight: boolean;
  temperatureC: number;
  precipChance: number;
};
export type StripSunCell = { kind: "sunrise" | "sunset"; key: string; atMs: number };
export type StripCell = StripHourCell | StripSunCell;

/** The forecast's « today »: the calendar day of `asOfMs` in the location. */
export function forecastToday(weather: Pick<WeatherCardData, "asOfMs" | "timeZone">): string {
  return zonedDayKey(weather.asOfMs, weather.timeZone);
}

/** The hours of one calendar day of the location, in order. */
export function hoursOfDay(weather: WeatherCardData, dayKey: string): WeatherCardData["hours"] {
  return weather.hours.filter((hour) => zonedDayKey(hour.startMs, weather.timeZone) === dayKey);
}

function hourCell(hour: WeatherCardData["hours"][number]): StripHourCell {
  return { kind: "hour", key: `h:${hour.startMs}`, isNow: false, ...hour };
}

/**
 * The hourly strip. Default: « Maintenant » (the current conditions, with
 * the chance of the hour in progress), then the next hours. For another day:
 * that day's hours. Sunrises and sunsets that fall inside the strip's span
 * are inserted at their exact minute, after the hour they fall in.
 */
export function hourlyCells(weather: WeatherCardData, dayKey: string | null): StripCell[] {
  const sorted = [...weather.hours].sort((a, b) => a.startMs - b.startMs);
  const ofDay = dayKey === null ? [] : hoursOfDay({ ...weather, hours: sorted }, dayKey);
  let cells: StripHourCell[];
  let spanStart: number;
  if (ofDay.length > 0) {
    cells = ofDay.map(hourCell);
    spanStart = ofDay[0]!.startMs;
  } else {
    const { asOfMs, current } = weather;
    const inProgress = sorted.find((hour) => hour.startMs <= asOfMs && asOfMs < hour.startMs + HOUR_MS);
    const now: StripHourCell = {
      kind: "hour",
      key: "now",
      startMs: asOfMs,
      isNow: true,
      conditionCode: current.conditionCode,
      daylight: current.daylight,
      temperatureC: current.temperatureC,
      precipChance: inProgress?.precipChance ?? 0,
    };
    const next = sorted.filter((hour) => hour.startMs > asOfMs).slice(0, STRIP_HOURS - 1);
    cells = [now, ...next.map(hourCell)];
    spanStart = asOfMs;
  }
  const lastHour = cells[cells.length - 1]!;
  const spanEnd = lastHour.isNow ? lastHour.startMs : lastHour.startMs + HOUR_MS;
  const events: StripSunCell[] = [];
  for (const day of weather.days) {
    for (const [kind, atMs] of [["sunrise", day.sunriseMs], ["sunset", day.sunsetMs]] as const) {
      if (atMs === undefined || atMs <= spanStart || atMs >= spanEnd) continue;
      events.push({ kind, key: `${kind}:${atMs}`, atMs });
    }
  }
  if (events.length === 0) return cells;
  events.sort((a, b) => a.atMs - b.atMs);
  const merged: StripCell[] = [];
  let next = 0;
  for (const [index, cell] of cells.entries()) {
    merged.push(cell);
    const following = cells[index + 1];
    while (next < events.length && (following === undefined || events[next]!.atMs < following.startMs)) {
      merged.push(events[next]!);
      next += 1;
    }
  }
  return merged;
}

export type WeatherHeader = {
  conditionCode: string;
  daylight: boolean;
  temperatureC: number;
  maxC: number | null;
  minC: number | null;
} & ({ kind: "current"; apparentC: number; windKph: number; humidity: number } | { kind: "day"; precipChance: number });

/** The big block: the current conditions, or the chosen day's forecast. */
export function weatherHeader(weather: WeatherCardData, dayKey: string | null, todayKey: string): WeatherHeader {
  const day = dayKey === null || dayKey === todayKey ? null : weather.days.find((candidate) => candidate.dateDay === dayKey);
  if (day) {
    return { kind: "day", conditionCode: day.conditionCode, daylight: true, temperatureC: day.maxC, maxC: day.maxC, minC: day.minC, precipChance: day.precipChance };
  }
  const today = weather.days.find((candidate) => candidate.dateDay === todayKey);
  const { current } = weather;
  return {
    kind: "current",
    conditionCode: current.conditionCode,
    daylight: current.daylight,
    temperatureC: current.temperatureC,
    maxC: today?.maxC ?? null,
    minC: today?.minC ?? null,
    apparentC: current.apparentC,
    windKph: current.windKph,
    humidity: current.humidity,
  };
}

/** The day the card opens on: the requested day when the forecast has it, else today. */
export function initialDay(weather: WeatherCardData, todayKey: string): string {
  const focus = weather.focusDay;
  return focus && weather.days.some((day) => day.dateDay === focus) ? focus : todayKey;
}

/**
 * Height of the current-conditions block, in rem. Below `WEATHER_NARROW_REM`
 * of card width the block stacks its condition text under the temperature
 * and takes the taller height. `run-cards.css` mirrors both numbers and
 * publishes the one in force as `--wx-block-h` to the card and its placeholder.
 */
export const WEATHER_BLOCK_WIDE_REM = 7;
export const WEATHER_BLOCK_NARROW_REM = 9;
export const WEATHER_NARROW_REM = 26;

/**
 * The card's height before its chunk has loaded, in the units the card
 * itself uses (`weather-card.tsx` sets each section to these heights), so
 * the thread does not move when the placeholder is swapped for the card.
 * Terms of a `calc()`, without the current block (`--wx-block-h`, set by the
 * container query), which the placeholder's CSS adds.
 */
export function weatherCardHeight(weather: WeatherCardData): string {
  let rem = 3; // header; the current block follows as `--wx-block-h`
  rem += 2.25 + 6.5; // hourly title and strip (the « now » column always exists)
  const week = (weather.display ?? "week") === "week";
  if (week) {
    rem += 2.25 + 0.25 + Math.min(weather.days.length, COLLAPSED_DAYS) * 2.75;
    if (weather.days.length > COLLAPSED_DAYS) rem += 2.25;
  } else {
    rem += 2.75;
  }
  rem += 2.5; // footer
  // The card's own border and the dividers of the hourly and daily sections;
  // the footer and the « full forecast » button hold theirs inside their height.
  return `${rem}rem + ${week ? 4 : 3}px`;
}
