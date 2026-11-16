import { describe, expect, test } from "bun:test";
import { WEATHER_CONDITION_CODES } from "@openedbot/contracts-events";
import { clockLabel, hourLabel, weekdayLabel, zonedClock, zonedDayKey } from "../../../src/lib/cards/weather-time";
import { isKnownCondition, weatherGlyph } from "../../../src/components/cards/weather-icons";

const PARIS = "Europe/Paris";

describe("labels in the location's zone", () => {
  test("hours read « 14 h » in French and « 2 PM » in English", () => {
    const at = Date.parse("2026-11-16T13:00:00.000Z");
    expect(hourLabel("fr", at, PARIS)).toBe("14 h");
    expect(hourLabel("en", at, PARIS)).toBe("2 PM");
    expect(hourLabel("fr", at, "America/New_York")).toBe("8 h");
  });

  test("hours are never zero-padded and midnight is « 0 h » / « 12 AM »", () => {
    const midnight = Date.parse("2026-11-16T23:00:00.000Z");
    expect(hourLabel("fr", midnight, PARIS)).toBe("0 h");
    expect(hourLabel("en", midnight, PARIS)).toBe("12 AM");
    const morning = Date.parse("2026-11-16T07:00:00.000Z");
    expect(hourLabel("fr", morning, PARIS)).toBe("8 h");
    expect(hourLabel("en", morning, PARIS)).toBe("8 AM");
    expect(hourLabel("en", Date.parse("2026-11-16T11:00:00.000Z"), PARIS)).toBe("12 PM");
    expect(hourLabel("en", Date.parse("2026-11-16T13:00:00.000Z"), PARIS)).toBe("2 PM");
  });

  test("a clock time keeps its minutes", () => {
    const sunset = Date.parse("2026-11-16T16:28:00.000Z");
    expect(clockLabel("fr", sunset, PARIS)).toBe("17:28");
    expect(clockLabel("en", sunset, PARIS)).toBe("5:28 PM");
  });

  test("the autumn change repeats 2 h and the spring change skips it", () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET.
    expect(hourLabel("fr", Date.parse("2026-10-25T00:00:00.000Z"), PARIS)).toBe("2 h");
    expect(hourLabel("fr", Date.parse("2026-10-25T01:00:00.000Z"), PARIS)).toBe("2 h");
    expect(hourLabel("fr", Date.parse("2026-10-25T02:00:00.000Z"), PARIS)).toBe("3 h");
    // 2026-03-29: 02:00 CET becomes 03:00 CEST.
    expect(hourLabel("fr", Date.parse("2026-03-29T00:00:00.000Z"), PARIS)).toBe("1 h");
    expect(hourLabel("fr", Date.parse("2026-03-29T01:00:00.000Z"), PARIS)).toBe("3 h");
  });

  test("day keys and clocks follow the zone across midnight and DST", () => {
    expect(zonedDayKey(Date.parse("2026-10-24T22:30:00.000Z"), PARIS)).toBe("2026-10-25");
    expect(zonedDayKey(Date.parse("2026-10-25T22:30:00.000Z"), PARIS)).toBe("2026-10-25");
    expect(zonedClock(Date.parse("2026-11-16T23:05:00.000Z"), PARIS)).toEqual({ dayKey: "2026-11-17", hour: 0, minute: 5 });
  });

  test("a weekday is read from the calendar day itself, whatever the viewer's zone", () => {
    expect(weekdayLabel("fr", "2026-11-17")).toBe("mar.");
    expect(weekdayLabel("en", "2026-11-17")).toBe("Tue");
    expect(weekdayLabel("fr", "2026-03-29")).toBe("dim.");
  });
});

describe("condition glyphs", () => {
  test("every known code has a glyph other than the generic one", () => {
    for (const code of WEATHER_CONDITION_CODES) {
      expect(isKnownCondition(code)).toBe(true);
      expect(weatherGlyph(code, true)).not.toBe("unknown");
    }
  });

  test("clear and partly cloudy skies follow day and night", () => {
    expect(weatherGlyph("Clear", true)).toBe("sun");
    expect(weatherGlyph("MostlyClear", false)).toBe("moon");
    expect(weatherGlyph("PartlyCloudy", false)).toBe("cloudMoon");
    expect(weatherGlyph("Drizzle", false)).toBe("drizzle");
    expect(weatherGlyph("MixedRainAndSnow", true)).toBe("sleet");
  });

  test("an unknown code maps to the generic glyph", () => {
    expect(isKnownCondition("SandstormOnMars")).toBe(false);
    expect(weatherGlyph("SandstormOnMars", true)).toBe("unknown");
  });
});
