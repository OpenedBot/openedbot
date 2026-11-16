/**
 * Rich cards a tool result can carry next to its text (`tool.result.cards`).
 *
 * The union is discriminated by `kind` so more kinds can join without
 * touching readers: a client renders the kinds it knows and skips the rest.
 * Payloads are provider-agnostic and metric on the wire; a client converts
 * units at display time. Everything arriving from a runtime is untrusted, so
 * `isRunCard` checks every field, range and bound before a card is shown:
 * an invalid card is dropped, never half-rendered.
 */

/**
 * The condition vocabulary of the weather card. It follows the
 * `conditionCode` values of the planned provider so its data passes through
 * losslessly; a code outside this list stays valid and renders generically.
 */
export const WEATHER_CONDITION_CODES = [
  "Clear", "MostlyClear", "PartlyCloudy", "MostlyCloudy", "Cloudy",
  "Foggy", "Haze", "Smoky", "Breezy", "Windy",
  "Drizzle", "Rain", "HeavyRain",
  "IsolatedThunderstorms", "ScatteredThunderstorms", "StrongStorms", "Thunderstorms",
  "Flurries", "Snow", "HeavySnow", "Sleet", "FreezingDrizzle", "FreezingRain",
  "MixedRainAndSleet", "MixedRainAndSnow", "MixedSnowAndSleet", "Hail",
  "Blizzard", "BlowingSnow", "Frigid", "Hot", "SunShowers", "SunFlurries",
  "WintryMix", "BlowingDust", "Hurricane", "TropicalStorm", "Tornado",
] as const;

export type WeatherConditionCode = (typeof WEATHER_CONDITION_CODES)[number];

export const WEATHER_PRECIP_TYPES = ["clear", "precipitation", "rain", "snow", "sleet", "hail", "mixed"] as const;
export type WeatherPrecipType = (typeof WEATHER_PRECIP_TYPES)[number];

export const WEATHER_DISPLAYS = ["now", "day", "week"] as const;
export type WeatherDisplay = (typeof WEATHER_DISPLAYS)[number];

export type WeatherCurrent = {
  /** A `WEATHER_CONDITION_CODES` value, or another code rendered generically. */
  conditionCode: string;
  daylight: boolean;
  temperatureC: number;
  apparentC: number;
  /** Relative humidity, 0..1. */
  humidity: number;
  windKph: number;
  uvIndex?: number;
};

export type WeatherDay = {
  /** The calendar day in the location's time zone. */
  dateDay: string;
  startMs: number;
  conditionCode: string;
  maxC: number;
  minC: number;
  /** 0..1. */
  precipChance: number;
  precipType?: WeatherPrecipType;
  sunriseMs?: number;
  sunsetMs?: number;
};

export type WeatherHour = {
  startMs: number;
  conditionCode: string;
  daylight: boolean;
  temperatureC: number;
  /** 0..1. */
  precipChance: number;
};

export type WeatherCardData = {
  locationLabel: string;
  /** IANA zone of the location: every hour and day label is read in it. */
  timeZone: string;
  asOfMs: number;
  /** The data provider's required credit: its label and an https link. */
  attribution: { label: string; url: string };
  /** What the request focused on; `week` when absent. */
  display?: WeatherDisplay;
  /** The day the request was about, `YYYY-MM-DD` in `timeZone`. */
  focusDay?: string;
  current: WeatherCurrent;
  days: WeatherDay[];
  hours: WeatherHour[];
};

export type WeatherRunCard = { kind: "weather"; weather: WeatherCardData };

export type RunCard = WeatherRunCard;

export type RunCardKind = RunCard["kind"];

/** Bounds: a hostile or broken payload must not inflate an event or a render. */
export const RUN_CARD_LIMITS = {
  cardsPerResult: 4,
  days: { min: 1, max: 16 },
  hours: { max: 240 },
  label: 120,
  attributionLabel: 80,
  url: 2048,
  timeZone: 64,
} as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max;
}

/** An absent optional field is fine; a present one must be valid. */
function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

const TEMPERATURE_C = [-100, 70] as const;
/** Any instant between 2000 and 2200: rejects seconds passed as milliseconds and garbage. */
const EPOCH_MS = [946_684_800_000, 7_258_118_400_000] as const;
const CONDITION_CODE = /^[A-Za-z]{1,40}$/;
const DATE_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HTTPS_URL = /^https:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/i;

const isTemperature = (value: unknown) => isNumberIn(value, TEMPERATURE_C[0], TEMPERATURE_C[1]);
const isInstant = (value: unknown) => isNumberIn(value, EPOCH_MS[0], EPOCH_MS[1]);
const isChance = (value: unknown) => isNumberIn(value, 0, 1);
const isCondition = (value: unknown) => typeof value === "string" && CONDITION_CODE.test(value);
const isDateDay = (value: unknown) => typeof value === "string" && DATE_DAY.test(value);

const knownZones = new Map<string, boolean>();

/** A zone the runtime's `Intl` can format in: the card reads every label through it. */
function isTimeZone(value: unknown): value is string {
  if (!isText(value, RUN_CARD_LIMITS.timeZone)) return false;
  const known = knownZones.get(value);
  if (known !== undefined) return known;
  let valid: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    valid = true;
  } catch {
    valid = false;
  }
  if (knownZones.size < 256) knownZones.set(value, valid);
  return valid;
}

function isAttribution(value: unknown): boolean {
  return isObject(value)
    && isText(value.label, RUN_CARD_LIMITS.attributionLabel)
    && typeof value.url === "string"
    && value.url.length <= RUN_CARD_LIMITS.url
    && HTTPS_URL.test(value.url);
}

function isCurrent(value: unknown): boolean {
  return isObject(value)
    && isCondition(value.conditionCode)
    && typeof value.daylight === "boolean"
    && isTemperature(value.temperatureC)
    && isTemperature(value.apparentC)
    && isChance(value.humidity)
    && isNumberIn(value.windKph, 0, 500)
    && optional(value.uvIndex, (uv) => isNumberIn(uv, 0, 20));
}

function isDay(value: unknown): boolean {
  return isObject(value)
    && isDateDay(value.dateDay)
    && isInstant(value.startMs)
    && isCondition(value.conditionCode)
    && isTemperature(value.maxC)
    && isTemperature(value.minC)
    && (value.minC as number) <= (value.maxC as number)
    && isChance(value.precipChance)
    && optional(value.precipType, (type) => (WEATHER_PRECIP_TYPES as readonly unknown[]).includes(type))
    && optional(value.sunriseMs, isInstant)
    && optional(value.sunsetMs, isInstant);
}

function isHour(value: unknown): boolean {
  return isObject(value)
    && isInstant(value.startMs)
    && isCondition(value.conditionCode)
    && typeof value.daylight === "boolean"
    && isTemperature(value.temperatureC)
    && isChance(value.precipChance);
}

export function isWeatherCardData(value: unknown): value is WeatherCardData {
  if (!isObject(value)) return false;
  const { days, hours } = value;
  return isText(value.locationLabel, RUN_CARD_LIMITS.label)
    && isTimeZone(value.timeZone)
    && isInstant(value.asOfMs)
    && isAttribution(value.attribution)
    && optional(value.display, (display) => (WEATHER_DISPLAYS as readonly unknown[]).includes(display))
    && optional(value.focusDay, isDateDay)
    && isCurrent(value.current)
    && Array.isArray(days)
    && days.length >= RUN_CARD_LIMITS.days.min
    && days.length <= RUN_CARD_LIMITS.days.max
    && days.every(isDay)
    && Array.isArray(hours)
    && hours.length <= RUN_CARD_LIMITS.hours.max
    && hours.every(isHour);
}

/** Strict guard: `false` for any unknown kind or any invalid field. */
export function isRunCard(value: unknown): value is RunCard {
  if (!isObject(value)) return false;
  if (value.kind === "weather") return isWeatherCardData(value.weather);
  return false;
}

const NO_CARDS: readonly RunCard[] = Object.freeze([]);
const readCards = new WeakMap<object, readonly RunCard[]>();

/**
 * The valid cards of a `tool.result.cards` value, invalid ones dropped and the
 * count capped. Memoized per payload array: a thread rebuilds its model on
 * every stream tick, and the same stored event must yield the same array so
 * a rendered card is not revalidated nor re-rendered.
 */
export function readRunCards(value: unknown): readonly RunCard[] {
  if (!Array.isArray(value) || value.length === 0) return NO_CARDS;
  const hit = readCards.get(value);
  if (hit) return hit;
  const cards = value.slice(0, RUN_CARD_LIMITS.cardsPerResult).filter(isRunCard);
  const result = cards.length > 0 ? cards : NO_CARDS;
  readCards.set(value, result);
  return result;
}
