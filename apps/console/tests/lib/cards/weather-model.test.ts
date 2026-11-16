import { describe, expect, test } from "bun:test";
import {
  COLLAPSED_DAYS,
  displayTemperature,
  displayWind,
  forecastBounds,
  forecastToday,
  gradientSlice,
  hourlyCells,
  initialDay,
  precipPercent,
  rangeFractions,
  scaleFraction,
  showsPrecip,
  STRIP_HOURS,
  temperatureColor,
  weatherCardHeight,
  weatherHeader,
} from "../../../src/lib/cards/weather-model";
import { AS_OF, HOUR_MS, weatherData, weatherDays } from "./weather-fixture";

describe("units", () => {
  test("temperatures convert at display time and round to integers, never to -0", () => {
    expect(displayTemperature(13.2, "celsius")).toBe(13);
    expect(displayTemperature(13.5, "celsius")).toBe(14);
    expect(displayTemperature(13.2, "fahrenheit")).toBe(56);
    expect(displayTemperature(-17.8, "fahrenheit")).toBe(0);
    expect(Object.is(displayTemperature(-0.2, "celsius"), 0)).toBe(true);
    expect(displayTemperature(-40, "fahrenheit")).toBe(-40);
  });

  test("wind follows the temperature unit: km/h with °C, mph with °F", () => {
    expect(displayWind(15, "celsius")).toEqual({ value: 15, unit: "kph" });
    expect(displayWind(15, "fahrenheit")).toEqual({ value: 9, unit: "mph" });
    expect(displayWind(0.3, "fahrenheit")).toEqual({ value: 0, unit: "mph" });
  });

  test("a precipitation chance shows from 10 %, rounded as displayed", () => {
    expect(precipPercent(0.886)).toBe(89);
    expect(precipPercent(1.4)).toBe(100);
    expect(showsPrecip(0.09)).toBe(false);
    expect(showsPrecip(0.095)).toBe(true);
    expect(showsPrecip(0.1)).toBe(true);
    expect(showsPrecip(0)).toBe(false);
  });
});

describe("range bars", () => {
  test("every bar shares the scale of the whole forecast", () => {
    const bounds = forecastBounds(weatherDays());
    expect(bounds).toEqual({ lowC: 1, highC: 16 });
    expect(rangeFractions(1, 16, bounds)).toEqual({ start: 0, end: 1 });
    const { start, end } = rangeFractions(9, 14, bounds);
    expect(start).toBeCloseTo(8 / 15);
    expect(end).toBeCloseTo(13 / 15);
  });

  test("a flat forecast fills the track and puts a marker in the middle", () => {
    const bounds = forecastBounds([{ minC: 5, maxC: 5 }]);
    expect(rangeFractions(5, 5, bounds)).toEqual({ start: 0, end: 1 });
    expect(scaleFraction(5, bounds)).toBe(0.5);
  });

  test("positions are clamped to the track", () => {
    expect(scaleFraction(40, { lowC: 0, highC: 10 })).toBe(1);
    expect(scaleFraction(-5, { lowC: 0, highC: 10 })).toBe(0);
  });

  test("the palette is absolute in °C and held beyond its ends", () => {
    expect(temperatureColor(-12)).toBe(temperatureColor(0));
    expect(temperatureColor(45)).toBe(temperatureColor(33));
    expect(temperatureColor(14)).toBe("rgb(52 199 123)");
    expect(temperatureColor(11)).not.toBe(temperatureColor(14));
  });

  test("a segment is a slice of one global gradient: ends at their own color, inner stops at their place", () => {
    expect(gradientSlice(10, 16)).toBe(
      `linear-gradient(90deg, ${temperatureColor(10)} 0%, ${temperatureColor(14)} 66.67%, ${temperatureColor(16)} 100%)`,
    );
    // Two adjacent days meeting at 14 °C share the color at the seam.
    expect(gradientSlice(9, 14).endsWith(`${temperatureColor(14)} 100%)`)).toBe(true);
    expect(gradientSlice(4, 4)).toBe(temperatureColor(4));
  });
});

describe("hourly strip", () => {
  test("starts with « now » from the current conditions, then the following hours", () => {
    const cells = hourlyCells(weatherData(), null);
    const hours = cells.filter((cell) => cell.kind === "hour");
    expect(hours).toHaveLength(STRIP_HOURS);
    expect(hours[0]).toMatchObject({ isNow: true, startMs: AS_OF, temperatureC: 13.2, precipChance: 0.4, conditionCode: "Drizzle" });
    expect(hours[1]!.startMs).toBe(Date.parse("2026-11-16T13:00:00.000Z"));
  });

  test("inserts sunset and sunrise at their minute, after the hour they fall in", () => {
    const cells = hourlyCells(weatherData(), null);
    const sunset = cells.findIndex((cell) => cell.kind === "sunset");
    expect(cells[sunset]).toMatchObject({ atMs: Date.parse("2026-11-16T16:28:00.000Z") });
    expect(cells[sunset - 1]).toMatchObject({ kind: "hour", startMs: Date.parse("2026-11-16T16:00:00.000Z") });
    expect(cells[sunset + 1]).toMatchObject({ kind: "hour", startMs: Date.parse("2026-11-16T17:00:00.000Z") });
    // Today's sunrise is past; tomorrow's is inside the 24 hours.
    expect(cells.filter((cell) => cell.kind === "sunrise").map((cell) => cell.kind === "sunrise" && cell.atMs))
      .toEqual([Date.parse("2026-11-17T07:21:00.000Z")]);
  });

  test("a chosen day shows its own hours, without « now »", () => {
    const cells = hourlyCells(weatherData(), "2026-11-17");
    const hours = cells.filter((cell) => cell.kind === "hour");
    expect(hours.some((cell) => cell.kind === "hour" && cell.isNow)).toBe(false);
    expect(hours[0]!.startMs).toBe(Date.parse("2026-11-16T23:00:00.000Z"));
    expect(hours).toHaveLength(24);
    expect(cells.filter((cell) => cell.kind !== "hour").map((cell) => cell.kind)).toEqual(["sunrise", "sunset"]);
  });

  test("a chosen day without hours falls back to the default strip", () => {
    const cells = hourlyCells(weatherData(), "2026-11-20");
    expect(cells[0]).toMatchObject({ kind: "hour", isNow: true });
  });

  test("a forecast without hours still has its « now » column and no sun event", () => {
    expect(hourlyCells(weatherData({ hours: [] }), null)).toEqual([
      expect.objectContaining({ kind: "hour", isNow: true, precipChance: 0 }),
    ]);
  });
});

describe("header and initial state", () => {
  test("today reads the current conditions with today's range", () => {
    const weather = weatherData();
    const today = forecastToday(weather);
    expect(today).toBe("2026-11-16");
    expect(weatherHeader(weather, today, today)).toMatchObject({ kind: "current", temperatureC: 13.2, maxC: 16, minC: 10, apparentC: 9.4 });
  });

  test("another day reads its forecast", () => {
    const weather = weatherData();
    expect(weatherHeader(weather, "2026-11-17", "2026-11-16")).toMatchObject({ kind: "day", conditionCode: "Rain", temperatureC: 14, maxC: 14, minC: 9, precipChance: 0.85 });
  });

  test("the card opens on the requested day when the forecast has it", () => {
    expect(initialDay(weatherData({ focusDay: "2026-11-18" }), "2026-11-16")).toBe("2026-11-18");
    expect(initialDay(weatherData({ focusDay: "2027-01-01" }), "2026-11-16")).toBe("2026-11-16");
    expect(initialDay(weatherData(), "2026-11-16")).toBe("2026-11-16");
  });

  test("today is the location's calendar day, not the viewer's", () => {
    const lateEvening = Date.parse("2026-11-16T23:30:00.000Z");
    expect(forecastToday({ asOfMs: lateEvening, timeZone: "Europe/Paris" })).toBe("2026-11-17");
    expect(forecastToday({ asOfMs: lateEvening, timeZone: "America/Montreal" })).toBe("2026-11-16");
  });
});

describe("placeholder height", () => {
  test("mirrors the card's sections: a week shows five rows and « Afficher plus »", () => {
    expect(COLLAPSED_DAYS).toBe(5);
    // 3 + 7 + 2.25 + 6.5 + 2.25 + 0.25 + 5 × 2.75 + 2.25 + 2.5
    expect(weatherCardHeight(weatherData())).toBe("32.75rem + 4px");
    expect(weatherCardHeight(weatherData({ days: weatherDays().slice(0, 2) }))).toBe("22.25rem + 4px");
    expect(weatherCardHeight(weatherData({ display: "now" }))).toBe("17rem + 3px");
  });

  test("hour data never changes it", () => {
    expect(weatherCardHeight(weatherData({ hours: [] }))).toBe(weatherCardHeight(weatherData()));
    expect(HOUR_MS).toBe(3_600_000);
  });
});
