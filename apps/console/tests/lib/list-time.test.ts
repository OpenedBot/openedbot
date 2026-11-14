import { describe, expect, test } from "bun:test";
import { formatListTime } from "@openedbot/browser-i18n";

// The runner's local time: dates are built in local time, like the
// calendar-day math of `formatListTime`.
const now = new Date(2026, 9, 13, 0, 10);
const at = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString();

describe("heure courte d'une ligne de la barre latérale", () => {
  test("aujourd'hui : l'heure", () => {
    expect(formatListTime("fr", at(2026, 9, 13, 0, 5), now)).toBe("00:05");
  });

  test("la veille, même à vingt minutes près : « hier »", () => {
    expect(formatListTime("fr", at(2026, 9, 12, 23, 50), now)).toBe("hier");
    expect(formatListTime("en", at(2026, 9, 12, 23, 50), now)).toBe("yesterday");
  });

  test("cette semaine : le jour", () => {
    // 7 October 2026 is a Wednesday.
    expect(formatListTime("fr", at(2026, 9, 7, 9, 0), now)).toBe("mer.");
    expect(formatListTime("en", at(2026, 9, 7, 9, 0), now)).toBe("Wed");
  });

  test("au-delà : une date courte, l'année hors de l'année en cours", () => {
    expect(formatListTime("fr", at(2026, 9, 6, 9, 0), now)).toBe("6 oct.");
    expect(formatListTime("en", at(2025, 11, 24, 9, 0), now)).toBe("Dec 24, 2025");
  });

  test("sans date lisible : rien", () => {
    expect(formatListTime("fr", null, now)).toBe("");
    expect(formatListTime("fr", "pas une date", now)).toBe("");
  });
});
