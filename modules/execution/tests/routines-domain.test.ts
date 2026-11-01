import { describe, expect, test } from "bun:test";
import {
  ROUTINE_LIMITS,
  countMissedOccurrences,
  isValidCron,
  isValidTimeZone,
  nextOccurrence,
  parseCron,
  routineFireText,
} from "../src/domain/routines";

function setOf(...values: number[]): Set<number> {
  return new Set(values);
}

function expectSet(actual: ReadonlySet<number>, expected: ReadonlySet<number>): void {
  expect([...actual].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
}

describe("parseCron", () => {
  test("listes, plages, pas et étoile", () => {
    const parsed = parseCron("0,15,30,45 8-18/2 */2 1-12 1-5");
    expect(parsed).not.toBeNull();
    expectSet(parsed!.minute, setOf(0, 15, 30, 45));
    expectSet(parsed!.hour, setOf(8, 10, 12, 14, 16, 18));
    expectSet(parsed!.dom, setOf(1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31));
    expectSet(parsed!.month, setOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12));
    expectSet(parsed!.dow, setOf(1, 2, 3, 4, 5));
    expect(parsed!.domStar).toBe(false);
    expect(parsed!.dowStar).toBe(false);
  });

  test("une étoile littérale pose domStar / dowStar", () => {
    const daily = parseCron("0 9 * * 1-5");
    expect(daily?.domStar).toBe(true);
    expect(daily?.dowStar).toBe(false);
    const anyDow = parseCron("0 9 1 * *");
    expect(anyDow?.domStar).toBe(false);
    expect(anyDow?.dowStar).toBe(true);
  });

  test("alias 7 → 0 (dimanche)", () => {
    const sunday = parseCron("0 0 * * 7");
    expect(sunday).not.toBeNull();
    expectSet(sunday!.dow, setOf(0));
    expect(sunday!.dow.has(7)).toBe(false);
    const range = parseCron("0 0 * * 0-7");
    expectSet(range!.dow, setOf(0, 1, 2, 3, 4, 5, 6));
  });

  test("refuse un pas sur une valeur seule (5/2)", () => {
    expect(parseCron("5/2 * * * *")).toBeNull();
    expect(parseCron("* 5/2 * * *")).toBeNull();
    expect(parseCron("0 0 5/2 * *")).toBeNull();
  });

  test("accepte un pas sur une étoile ou une plage", () => {
    expectSet(parseCron("*/15 * * * *")!.minute, setOf(0, 15, 30, 45));
    expectSet(parseCron("0-30/10 * * * *")!.minute, setOf(0, 10, 20, 30));
  });

  test("refuse 4 ou 6 champs, et les alias textuels", () => {
    expect(parseCron("0 9 * *")).toBeNull();
    expect(parseCron("0 9 * * * *")).toBeNull();
    expect(parseCron("@daily")).toBeNull();
    expect(parseCron("0 9 * * MON")).toBeNull();
    expect(parseCron("0 9 * JAN *")).toBeNull();
    expect(parseCron("")).toBeNull();
    expect(parseCron("   ")).toBeNull();
  });

  test("refuse les valeurs hors bornes", () => {
    expect(parseCron("60 * * * *")).toBeNull();
    expect(parseCron("0 24 * * *")).toBeNull();
    expect(parseCron("0 0 0 * *")).toBeNull();
    expect(parseCron("0 0 32 * *")).toBeNull();
    expect(parseCron("0 0 1 0 *")).toBeNull();
    expect(parseCron("0 0 1 13 *")).toBeNull();
    expect(parseCron("0 0 * * 8")).toBeNull();
    expect(parseCron("-1 * * * *")).toBeNull();
  });

  test("refuse une plage inversée, un pas nul, une virgule vide", () => {
    expect(parseCron("5-1 * * * *")).toBeNull();
    expect(parseCron("*/0 * * * *")).toBeNull();
    expect(parseCron("1,,2 * * * *")).toBeNull();
    expect(parseCron("1-5/ * * * *")).toBeNull();
  });

  test("tolère les espaces superflus autour de 5 champs valides", () => {
    expect(parseCron("  0  9 * * 1-5  ")).not.toBeNull();
  });
});

describe("isValidCron", () => {
  test("suit parseCron", () => {
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("0 * * * *")).toBe(true);
    expect(isValidCron("5/2 * * * *")).toBe(false);
    expect(isValidCron("@hourly")).toBe(false);
    expect(isValidCron("0 9 * * MON")).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  test("accepte les identifiants IANA courants", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Paris")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
  });

  test("refuse un identifiant inconnu ou vide", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("nextOccurrence", () => {
  test("est strictement après `from`", () => {
    const from = new Date("2026-01-15T09:00:00.000Z");
    expect(nextOccurrence("0 9 * * *", from, "UTC")?.toISOString()).toBe("2026-01-16T09:00:00.000Z");
    const justBefore = new Date("2026-01-15T08:59:00.000Z");
    expect(nextOccurrence("0 9 * * *", justBefore, "UTC")?.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    const midMinute = new Date("2026-01-15T08:59:30.000Z");
    expect(nextOccurrence("0 9 * * *", midMinute, "UTC")?.toISOString()).toBe("2026-01-15T09:00:00.000Z");
  });

  test("minute et heure exactes", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(nextOccurrence("17 13 * * *", from, "UTC")?.toISOString()).toBe("2026-01-01T13:17:00.000Z");
    expect(nextOccurrence("0 0 * * *", from, "UTC")?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  test("règle OU POSIX : jour-du-mois et jour-de-semaine restreints", () => {
    // 1er, 15 et lundis à minuit UTC. 2026-01-01 est un jeudi.
    const fromNewYear = new Date("2026-01-01T00:00:00.000Z");
    expect(nextOccurrence("0 0 1,15 * 1", fromNewYear, "UTC")?.toISOString()).toBe("2026-01-05T00:00:00.000Z");

    const fromFourteenth = new Date("2026-01-14T00:00:00.000Z");
    expect(nextOccurrence("0 0 1,15 * 1", fromFourteenth, "UTC")?.toISOString()).toBe("2026-01-15T00:00:00.000Z");

    const fromFifteenth = new Date("2026-01-15T00:00:00.000Z");
    expect(nextOccurrence("0 0 1,15 * 1", fromFifteenth, "UTC")?.toISOString()).toBe("2026-01-19T00:00:00.000Z");
  });

  test("un seul champ jour restreint se lit en ET (l'étoile ne déclenche pas le OU)", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(nextOccurrence("0 0 1 * *", from, "UTC")?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(nextOccurrence("0 0 * * 1", from, "UTC")?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  test("Europe/Paris: bascule de printemps 2026-03-29 (02:00 → 03:00)", () => {
    const from = new Date("2026-03-28T08:00:00.000Z"); // 09:00 CET
    const next = nextOccurrence("0 9 * * *", from, "Europe/Paris");
    expect(next?.toISOString()).toBe("2026-03-29T07:00:00.000Z"); // 09:00 CEST
    const after = nextOccurrence("0 9 * * *", next!, "Europe/Paris");
    expect(after?.toISOString()).toBe("2026-03-30T07:00:00.000Z");
  });

  test("Europe/Paris: bascule d'automne 2026-10-25 (03:00 → 02:00)", () => {
    const from = new Date("2026-10-24T07:00:00.000Z"); // 09:00 CEST
    const next = nextOccurrence("0 9 * * *", from, "Europe/Paris");
    expect(next?.toISOString()).toBe("2026-10-25T08:00:00.000Z"); // 09:00 CET
    const after = nextOccurrence("0 9 * * *", next!, "Europe/Paris");
    expect(after?.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  test("America/New_York: bascule de printemps 2026-03-08", () => {
    const from = new Date("2026-03-07T14:00:00.000Z"); // 09:00 EST
    expect(nextOccurrence("0 9 * * *", from, "America/New_York")?.toISOString()).toBe(
      "2026-03-08T13:00:00.000Z",
    );
  });

  test("America/New_York: bascule d'automne 2026-11-01", () => {
    const from = new Date("2026-10-31T13:00:00.000Z"); // 09:00 EDT
    expect(nextOccurrence("0 9 * * *", from, "America/New_York")?.toISOString()).toBe(
      "2026-11-01T14:00:00.000Z",
    );
  });

  test("limite 5 ans : 30 février ne matche jamais → null", () => {
    expect(nextOccurrence("0 0 30 2 *", new Date("2026-01-01T00:00:00.000Z"), "UTC")).toBeNull();
    expect(nextOccurrence("0 0 31 2 *", new Date("2026-01-01T00:00:00.000Z"), "UTC")).toBeNull();
  });

  test("29 février atterrit sur la prochaine année bissextile", () => {
    expect(nextOccurrence("0 0 29 2 *", new Date("2026-01-01T00:00:00.000Z"), "UTC")?.toISOString())
      .toBe("2028-02-29T00:00:00.000Z");
  });

  test("cron ou fuseau invalide → null", () => {
    expect(nextOccurrence("tous les jours", new Date(), "UTC")).toBeNull();
    expect(nextOccurrence("0 9 * * *", new Date(), "Mars/Olympus")).toBeNull();
  });
});

describe("countMissedOccurrences", () => {
  test("compte les occurrences strictement après l'échéance et ≤ maintenant", () => {
    const due = new Date("2026-01-01T09:00:00.000Z");
    const now = new Date("2026-01-01T15:00:00.000Z");
    expect(countMissedOccurrences("0 * * * *", due, now, "UTC")).toBe(6);
  });

  test("rien à compter quand on tire pile à l'échéance", () => {
    const due = new Date("2026-01-01T15:00:00.000Z");
    expect(countMissedOccurrences("0 * * * *", due, due, "UTC")).toBe(0);
  });

  test("plafonne à maxMissedCounted", () => {
    const due = new Date("2026-01-01T12:00:00.000Z");
    const now = new Date("2026-01-01T12:40:00.000Z");
    expect(countMissedOccurrences("* * * * *", due, now, "UTC")).toBe(ROUTINE_LIMITS.maxMissedCounted);
    expect(countMissedOccurrences("* * * * *", due, now, "UTC", 3)).toBe(3);
  });
});

describe("routineFireText", () => {
  test("préfixe visible de l'opérateur et du bot", () => {
    expect(routineFireText("Revue matinale", "Fais le point.")).toBe(
      "[Routine « Revue matinale »] Fais le point.",
    );
  });
});
