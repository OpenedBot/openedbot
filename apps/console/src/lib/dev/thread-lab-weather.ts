import type { RunCard, WeatherDay, WeatherHour } from "@openedbot/contracts-events";
import { zonedClock } from "../cards/weather-time";

/**
 * A realistic weather card for the thread lab, built around `nowMs` so
 * « Maintenant », today and the sunset fall where they would in a real
 * answer: Rennes in November, drizzle and rain, 7 days and 48 hours.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const TIME_ZONE = "Europe/Paris";

/** Drizzle, rain and clearer spells, one entry per day. */
const DAYS: readonly { code: string; minC: number; maxC: number; chance: number; type: WeatherDay["precipType"] }[] = [
  { code: "Drizzle", minC: 10, maxC: 16, chance: 0.6, type: "rain" },
  { code: "Rain", minC: 9, maxC: 14, chance: 0.85, type: "rain" },
  { code: "MostlyCloudy", minC: 6, maxC: 12, chance: 0.2, type: "rain" },
  { code: "PartlyCloudy", minC: 3, maxC: 11, chance: 0.05, type: "clear" },
  { code: "HeavyRain", minC: 7, maxC: 13, chance: 0.9, type: "rain" },
  { code: "Clear", minC: 1, maxC: 9, chance: 0, type: "clear" },
  { code: "Cloudy", minC: 4, maxC: 10, chance: 0.15, type: "rain" },
];

/** The local midnight of the day `ms` falls in (whole-hour zones; good enough for a fixture). */
function localMidnight(ms: number): number {
  const { hour, minute } = zonedClock(ms, TIME_ZONE);
  const floored = ms - (ms % MINUTE_MS);
  return floored - hour * HOUR_MS - minute * MINUTE_MS;
}

function dayKey(ms: number): string {
  return zonedClock(ms, TIME_ZONE).dayKey;
}

function hourCode(dayCode: string, hourOfDay: number, daylight: boolean): string {
  if (dayCode === "Drizzle") return hourOfDay < 11 ? "Drizzle" : hourOfDay < 16 ? "Rain" : daylight ? "MostlyCloudy" : "Cloudy";
  if (dayCode === "Rain") return hourOfDay < 7 ? "Cloudy" : hourOfDay < 18 ? "Rain" : "Drizzle";
  if (dayCode === "PartlyCloudy" || dayCode === "Clear") return daylight ? dayCode : "MostlyClear";
  return dayCode;
}

export function labWeatherCard(nowMs: number): RunCard {
  const asOfMs = nowMs - (nowMs % MINUTE_MS);
  const today = localMidnight(asOfMs);
  const days: WeatherDay[] = DAYS.map((day, index) => {
    const startMs = localMidnight(today + index * 24 * HOUR_MS + 12 * HOUR_MS);
    return {
      dateDay: dayKey(startMs + 12 * HOUR_MS),
      startMs,
      conditionCode: day.code,
      maxC: day.maxC,
      minC: day.minC,
      precipChance: day.chance,
      ...(day.type ? { precipType: day.type } : {}),
      sunriseMs: startMs + 8 * HOUR_MS + (21 + index) * MINUTE_MS,
      sunsetMs: startMs + 17 * HOUR_MS + (28 - index) * MINUTE_MS,
    };
  });
  const firstHour = asOfMs - (asOfMs % HOUR_MS);
  const hours: WeatherHour[] = Array.from({ length: 48 }, (_, index) => {
    const startMs = firstHour + index * HOUR_MS;
    const day = days.findLast((candidate) => candidate.startMs <= startMs) ?? days[0]!;
    const hourOfDay = zonedClock(startMs, TIME_ZONE).hour;
    const daylight = startMs >= (day.sunriseMs ?? 0) - HOUR_MS / 2 && startMs < (day.sunsetMs ?? 0);
    // Coldest before dawn, warmest mid-afternoon.
    const warmth = (1 - Math.cos(((hourOfDay - 5 + 24) % 24) / 24 * 2 * Math.PI)) / 2;
    const code = hourCode(day.conditionCode, hourOfDay, daylight);
    const wet = code === "Rain" || code === "Drizzle" || code === "HeavyRain";
    return {
      startMs,
      conditionCode: code,
      daylight,
      temperatureC: Math.round((day.minC + (day.maxC - day.minC) * warmth) * 10) / 10,
      precipChance: wet ? Math.min(1, day.precipChance + (hourOfDay % 3) * 0.05) : Math.max(0, day.precipChance - 0.15 - (hourOfDay % 2) * 0.05),
    };
  });
  const current = hours[0]!;
  return {
    kind: "weather",
    weather: {
      locationLabel: "Rennes",
      timeZone: TIME_ZONE,
      asOfMs,
      attribution: { label: "Données météo de démonstration", url: "https://example.com/weather-attribution" },
      display: "week",
      current: {
        conditionCode: current.conditionCode,
        daylight: current.daylight,
        temperatureC: current.temperatureC,
        apparentC: Math.round((current.temperatureC - 3.6) * 10) / 10,
        humidity: 0.88,
        windKph: 15,
        uvIndex: 1,
      },
      days,
      hours,
    },
  };
}
