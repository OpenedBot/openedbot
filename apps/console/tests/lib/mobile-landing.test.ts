import { beforeEach, describe, expect, test } from "bun:test";
import {
  consumeMobileLanding,
  firstRosterBotId,
  isMobileLandingConsumed,
  resetMobileLanding,
  setMobileLandingEntry,
} from "../../src/lib/mobile-landing";

type Bot = Parameters<typeof firstRosterBotId>[0][number];

function bot(id: string, overrides: Partial<Bot> = {}): Bot {
  return {
    id,
    pinned: false,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("first roster bot", () => {
  test("un registre vide laisse sur l'aperçu", () => {
    expect(firstRosterBotId([])).toBeNull();
  });

  test("le premier est celui du haut du panneau : épinglés d'abord, puis activité", () => {
    const bots = [
      bot("ancien", { lastActivityAt: "2026-01-01T00:00:00.000Z" }),
      bot("recent", { lastActivityAt: "2026-03-01T00:00:00.000Z" }),
      bot("epingle", { pinned: true, lastActivityAt: "2025-01-01T00:00:00.000Z" }),
    ];
    expect(firstRosterBotId(bots)).toBe("epingle");
    expect(firstRosterBotId(bots.filter((b) => !b.pinned))).toBe("recent");
  });

  test("masqués et archivés ne sont pas dans la colonne, donc jamais ouverts", () => {
    expect(
      firstRosterBotId([
        bot("masque", { hidden: true, lastActivityAt: "2026-06-01T00:00:00.000Z" }),
        bot("archive", { archivedAt: "2026-05-01T00:00:00.000Z", lastActivityAt: "2026-05-01T00:00:00.000Z" }),
        bot("courant"),
      ]),
    ).toBe("courant");
    expect(firstRosterBotId([bot("masque", { hidden: true })])).toBeNull();
  });
});

describe("landing latch", () => {
  beforeEach(() => resetMobileLanding());

  test("un lien profond a déjà dépensé son arrivée ; login et accueil, non", () => {
    setMobileLandingEntry("/bot/550e8400-e29b-41d4-a716-446655440000");
    expect(isMobileLandingConsumed()).toBe(true);
    setMobileLandingEntry("/settings/models");
    expect(isMobileLandingConsumed()).toBe(true);
    for (const entry of ["/", "/login", "/onboarding", "/legal/privacy"]) {
      setMobileLandingEntry(entry);
      expect(isMobileLandingConsumed()).toBe(false);
    }
  });

  test("l'arrivée n'a lieu qu'une fois : « Aperçu » reste atteignable ensuite", () => {
    expect(isMobileLandingConsumed()).toBe(false);
    expect(consumeMobileLanding()).toBe(true);
    expect(isMobileLandingConsumed()).toBe(true);
    expect(consumeMobileLanding()).toBe(false);
  });
});
