import { describe, expect, test } from "bun:test";
import { isRunCard, readRunCards, RUN_CARD_LIMITS, type RunCard, type WeatherCardData } from "../src/index";

const AS_OF = Date.parse("2026-11-16T12:40:00.000Z");
const HOUR = 3_600_000;

function weather(): WeatherCardData {
  return {
    locationLabel: "Rennes",
    timeZone: "Europe/Paris",
    asOfMs: AS_OF,
    attribution: { label: "Weather provider", url: "https://weather.example.com/attribution" },
    display: "week",
    current: { conditionCode: "Drizzle", daylight: true, temperatureC: 13.2, apparentC: 9.4, humidity: 0.88, windKph: 15, uvIndex: 1 },
    days: [
      { dateDay: "2026-11-16", startMs: Date.parse("2026-11-15T23:00:00.000Z"), conditionCode: "Rain", maxC: 16, minC: 10, precipChance: 0.6, precipType: "rain", sunriseMs: AS_OF - 5 * HOUR, sunsetMs: AS_OF + 4 * HOUR },
      { dateDay: "2026-11-17", startMs: Date.parse("2026-11-16T23:00:00.000Z"), conditionCode: "Cloudy", maxC: 14, minC: 8, precipChance: 0.1 },
    ],
    hours: [
      { startMs: AS_OF - 40 * 60_000, conditionCode: "Drizzle", daylight: true, temperatureC: 13, precipChance: 0.4 },
      { startMs: AS_OF + 20 * 60_000, conditionCode: "SomeFutureCode", daylight: true, temperatureC: 13.5, precipChance: 0 },
    ],
  };
}

function card(patch: (data: WeatherCardData & Record<string, unknown>) => void = () => {}): unknown {
  const data = weather() as WeatherCardData & Record<string, unknown>;
  patch(data);
  return { kind: "weather", weather: data };
}

describe("isRunCard", () => {
  test("accepts a complete weather card, unknown condition codes included", () => {
    expect(isRunCard(card())).toBe(true);
  });

  test("accepts a card without its optional fields", () => {
    expect(isRunCard(card((data) => {
      delete data.display;
      delete (data.current as Partial<WeatherCardData["current"]>).uvIndex;
      data.days = [{ dateDay: "2026-11-16", startMs: AS_OF, conditionCode: "Clear", maxC: 3, minC: 3, precipChance: 0 }];
      data.hours = [];
    }))).toBe(true);
  });

  test("rejects an unknown kind and non-objects", () => {
    expect(isRunCard({ kind: "stocks", weather: weather() })).toBe(false);
    expect(isRunCard(null)).toBe(false);
    expect(isRunCard([card()])).toBe(false);
    expect(isRunCard({ kind: "weather" })).toBe(false);
  });

  const invalid: Array<[string, (data: WeatherCardData & Record<string, unknown>) => void]> = [
    ["an empty location", (data) => { data.locationLabel = "  "; }],
    ["an overlong location", (data) => { data.locationLabel = "x".repeat(RUN_CARD_LIMITS.label + 1); }],
    ["an empty time zone", (data) => { data.timeZone = ""; }],
    ["a time zone Intl does not know", (data) => { data.timeZone = "Mars/Olympus_Mons"; }],
    ["an http attribution", (data) => { data.attribution = { label: "P", url: "http://weather.example.com" }; }],
    ["a javascript attribution", (data) => { data.attribution = { label: "P", url: "javascript:alert(1)" }; }],
    ["an attribution with credentials", (data) => { data.attribution = { label: "P", url: "https://user@evil.example.com" }; }],
    ["an attribution without label", (data) => { data.attribution = { label: "", url: "https://weather.example.com" }; }],
    ["asOfMs in seconds", (data) => { data.asOfMs = AS_OF / 1000; }],
    ["a non-finite temperature", (data) => { data.current.temperatureC = Number.NaN; }],
    ["an infinite apparent temperature", (data) => { data.current.apparentC = Number.POSITIVE_INFINITY; }],
    ["humidity as a percentage", (data) => { data.current.humidity = 88; }],
    ["a negative wind", (data) => { data.current.windKph = -1; }],
    ["a string UV index", (data) => { (data.current as Record<string, unknown>).uvIndex = "3"; }],
    ["a missing daylight flag", (data) => { delete (data.current as Partial<WeatherCardData["current"]>).daylight; }],
    ["a condition code with spaces", (data) => { data.current.conditionCode = "Light rain"; }],
    ["an unknown display", (data) => { (data as Record<string, unknown>).display = "month"; }],
    ["a malformed focus day", (data) => { data.focusDay = "16/11/2026"; }],
    ["no day", (data) => { data.days = []; }],
    ["too many days", (data) => { data.days = Array.from({ length: RUN_CARD_LIMITS.days.max + 1 }, () => data.days[0]!); }],
    ["a day whose min exceeds its max", (data) => { data.days[0]!.minC = 20; }],
    ["a malformed date day", (data) => { data.days[0]!.dateDay = "2026-13-01"; }],
    ["a precipitation chance above 1", (data) => { data.days[0]!.precipChance = 1.2; }],
    ["an unknown precipitation type", (data) => { (data.days[0] as Record<string, unknown>).precipType = "frogs"; }],
    ["a non-numeric sunset", (data) => { (data.days[0] as Record<string, unknown>).sunsetMs = "17:28"; }],
    ["a null sunrise", (data) => { (data.days[0] as Record<string, unknown>).sunriseMs = null; }],
    ["hours that are not an array", (data) => { (data as Record<string, unknown>).hours = {}; }],
    ["too many hours", (data) => { data.hours = Array.from({ length: RUN_CARD_LIMITS.hours.max + 1 }, () => data.hours[0]!); }],
    ["an hour with a negative chance", (data) => { data.hours[0]!.precipChance = -0.1; }],
    ["an hour without start", (data) => { delete (data.hours[0] as Partial<WeatherCardData["hours"][number]>).startMs; }],
  ];
  for (const [name, patch] of invalid) {
    test(`rejects ${name}`, () => {
      expect(isRunCard(card(patch))).toBe(false);
    });
  }
});

describe("readRunCards", () => {
  test("keeps valid cards, drops invalid ones and anything that is not an array", () => {
    const good = card();
    const cards = readRunCards([good, card((data) => { data.days = []; }), "weather"]);
    expect(cards).toEqual([good as RunCard]);
    expect(readRunCards(good)).toEqual([]);
    expect(readRunCards(undefined)).toEqual([]);
  });

  test("returns the same array for the same payload, so a render can rely on identity", () => {
    const payload = [card()];
    expect(readRunCards(payload)).toBe(readRunCards(payload));
  });

  test("caps the number of cards read from one result", () => {
    const payload = Array.from({ length: RUN_CARD_LIMITS.cardsPerResult + 3 }, () => card());
    expect(readRunCards(payload)).toHaveLength(RUN_CARD_LIMITS.cardsPerResult);
  });
});
