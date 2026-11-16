import type { WeatherCardData, WeatherDay, WeatherHour, WeatherRunCard } from "@openedbot/contracts-events";

/**
 * Rennes on Monday 2026-11-16, read at 13:40 local (12:40 UTC, Paris is
 * UTC+1 in November). Sunset 17:28 local; seven days, 48 hours from noon UTC.
 */
export const HOUR_MS = 3_600_000;
export const AS_OF = Date.parse("2026-11-16T12:40:00.000Z");
const MIDNIGHT = Date.parse("2026-11-15T23:00:00.000Z");

const DAYS: readonly [string, number, number, number][] = [
  ["Drizzle", 10, 16, 0.6],
  ["Rain", 9, 14, 0.85],
  ["MostlyCloudy", 6, 12, 0.05],
  ["PartlyCloudy", 3, 11, 0.12],
  ["HeavyRain", 7, 13, 0.9],
  ["Clear", 1, 9, 0],
  ["Cloudy", 4, 10, 0.15],
];

export function weatherDays(): WeatherDay[] {
  return DAYS.map(([code, minC, maxC, chance], index) => {
    const startMs = MIDNIGHT + index * 24 * HOUR_MS;
    return {
      dateDay: `2026-11-${String(16 + index).padStart(2, "0")}`,
      startMs,
      conditionCode: code,
      minC,
      maxC,
      precipChance: chance,
      sunriseMs: startMs + 8 * HOUR_MS + 21 * 60_000,
      sunsetMs: startMs + 17 * HOUR_MS + 28 * 60_000,
    };
  });
}

export function weatherHours(): WeatherHour[] {
  const first = Date.parse("2026-11-16T12:00:00.000Z");
  return Array.from({ length: 48 }, (_, index) => ({
    startMs: first + index * HOUR_MS,
    conditionCode: index < 3 ? "Drizzle" : "Cloudy",
    daylight: index < 4,
    temperatureC: 13 - index * 0.1,
    precipChance: index === 0 ? 0.4 : index === 1 ? 0.09 : 0.3,
  }));
}

export function weatherData(patch: Partial<WeatherCardData> = {}): WeatherCardData {
  return {
    locationLabel: "Rennes",
    timeZone: "Europe/Paris",
    asOfMs: AS_OF,
    attribution: { label: "Provider", url: "https://weather.example.com/legal" },
    current: { conditionCode: "Drizzle", daylight: true, temperatureC: 13.2, apparentC: 9.4, humidity: 0.88, windKph: 15 },
    days: weatherDays(),
    hours: weatherHours(),
    ...patch,
  };
}

export function weatherCard(patch: Partial<WeatherCardData> = {}): WeatherRunCard {
  return { kind: "weather", weather: weatherData(patch) };
}
