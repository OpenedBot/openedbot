import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotDto, RosterDto, SectionDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../src/lib/api";
import { I18nProvider } from "../../../src/lib/i18n";
import { PINNED_DROP_ID, pinSlotIndex, sectionSlotIndex, type RosterDragRow } from "../../../src/components/dashboard/roster-drag";
import { comparePinned, pinPreview } from "../../../src/components/boardui/board-pins";
import { useRosterSections } from "../../../src/components/dashboard/use-roster-sections";

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  cleanup();
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Une tuile de 116 × 100 px ; deux par rangée, à 12 px d'écart. */
const tile = (column: number, row: number) => ({
  left: 10 + column * 128,
  right: 126 + column * 128,
  top: 20 + row * 112,
  bottom: 120 + row * 112,
});

function bot(id: string, extra: Partial<BotDto> = {}): BotDto {
  return {
    id, threadId: `t-${id}`, name: id, slug: id, description: null, instructions: "", model: null, reasoningEffort: null,
    sectionId: "sec-default", position: 0, pinned: false, face: null, voiceId: null, hermesProfile: null,
    lastActivityAt: "2026-11-01T10:00:00.000Z", ...extra,
  } as BotDto;
}
const row = (id: string, extra: Partial<BotDto> = {}): RosterDragRow => ({ kind: "bot", bot: bot(id, extra) });

describe("emplacement dans la grille des épinglés (le t3e de Grok)", () => {
  const grid = [tile(0, 0), tile(1, 0), tile(0, 1)];

  test("une grille vide prend la tuile en tête", () => {
    expect(pinSlotIndex([], 50, 50)).toBe(0);
  });

  test("on compte les tuiles de la rangée dont le centre est avant le pointeur", () => {
    expect(pinSlotIndex(grid, 20, 60)).toBe(0);
    expect(pinSlotIndex(grid, 100, 60)).toBe(1);
    expect(pinSlotIndex(grid, 250, 60)).toBe(2);
    expect(pinSlotIndex(grid, 20, 180)).toBe(2);
    expect(pinSlotIndex(grid, 200, 180)).toBe(3);
  });

  test("la rangée se choisit au milieu de l'espace entre deux rangées", () => {
    // Bas de la 1re rangée : 120 ; haut de la 2e : 132 ; milieu : 126.
    expect(pinSlotIndex(grid, 200, 125)).toBe(2);
    expect(pinSlotIndex(grid, 200, 127)).toBe(3);
    // Sous la grille : la dernière rangée.
    expect(pinSlotIndex(grid, 20, 900)).toBe(2);
  });

  test("en RTL, la tuile « avant » est celle de droite", () => {
    expect(pinSlotIndex(grid, 250, 60, true)).toBe(0);
    expect(pinSlotIndex(grid, 20, 60, true)).toBe(2);
  });
});

describe("trait de dépôt d'une section", () => {
  test("le rang est le nombre de sections dont le milieu est au-dessus du pointeur", () => {
    const blocks = [{ left: 0, right: 200, top: 0, bottom: 100 }, { left: 0, right: 200, top: 104, bottom: 204 }];
    expect(sectionSlotIndex(blocks, 10)).toBe(0);
    expect(sectionSlotIndex(blocks, 60)).toBe(1);
    expect(sectionSlotIndex(blocks, 190)).toBe(2);
  });
});

describe("aperçu de la grille pendant un glisser", () => {
  const pins = [row("a", { pinned: true }), row("b", { pinned: true }), row("c", { pinned: true })];
  const keys = (items: ReturnType<typeof pinPreview>) => items.map((item) => `${item.placeholder ? "*" : ""}${item.row.kind === "bot" ? item.row.bot.id : ""}`);

  test("hors de la grille, l'ordre réel", () => {
    expect(keys(pinPreview(pins, row("x"), null))).toEqual(["a", "b", "c"]);
  });

  test("une ligne de la liste ouvre un emplacement à l'index visé", () => {
    expect(keys(pinPreview(pins, row("x"), 1))).toEqual(["a", "*x", "b", "c"]);
    expect(keys(pinPreview(pins, row("x"), 99))).toEqual(["a", "b", "c", "*x"]);
  });

  test("une tuile épinglée quitte sa place pour l'emplacement visé", () => {
    expect(keys(pinPreview(pins, pins[0]!, 2))).toEqual(["b", "c", "*a"]);
  });
});

describe("rang des épinglés", () => {
  test("par rang d'abord, les épinglés sans rang ensuite, par activité", () => {
    const rows = [
      row("recent", { pinned: true, pinPosition: null, lastActivityAt: "2026-11-02T00:00:00.000Z" }),
      row("second", { pinned: true, pinPosition: 1 }),
      row("old", { pinned: true, lastActivityAt: "2026-10-01T00:00:00.000Z" }),
      row("first", { pinned: true, pinPosition: 0 }),
    ] as Array<{ kind: "bot"; bot: BotDto }>;
    expect([...rows].sort(comparePinned).map((item) => item.bot.id)).toEqual(["first", "second", "recent", "old"]);
  });
});

describe("écritures du glisser", () => {
  const sections: SectionDto[] = [
    { id: "sec-default", name: "Bots", position: 0, collapsed: false },
    { id: "sec-a", name: "A", position: 1, collapsed: false },
    { id: "sec-b", name: "B", position: 2, collapsed: false },
    { id: "sec-c", name: "C", position: 3, collapsed: false },
  ];
  function harness(bots: BotDto[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData<RosterDto>(queryKeys.roster, { bots, groups: [], sections } as unknown as RosterDto);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider>
    );
    const hook = renderHook(() => useRosterSections(), { wrapper });
    return { client, hook };
  }

  test("déposer une ligne dans la grille l'épingle à son emplacement, d'une seule écriture", async () => {
    const orderPins = spyOn(api, "orderPins").mockResolvedValue(undefined);
    spies.push(orderPins);
    const pins = [bot("a", { pinned: true, pinPosition: 0 }), bot("b", { pinned: true, pinPosition: 1 })];
    const loose = bot("x");
    const { client, hook } = harness([...pins, loose]);
    await act(() => hook.result.current.dropRow(
      { kind: "bot", bot: loose },
      PINNED_DROP_ID,
      { sectionId: PINNED_DROP_ID, index: 1 },
      () => pins.map((pin) => ({ kind: "bot", bot: pin })),
    ));
    expect(orderPins).toHaveBeenCalledWith({ order: [{ kind: "bot", id: "a" }, { kind: "bot", id: "x" }, { kind: "bot", id: "b" }] });
    const roster = client.getQueryData<RosterDto>(queryKeys.roster)!;
    expect(roster.bots.find((candidate) => candidate.id === "x")).toMatchObject({ pinned: true, pinPosition: 1, sectionId: "sec-default" });
  });

  test("reposer une tuile à sa place n'écrit rien", async () => {
    const orderPins = spyOn(api, "orderPins").mockResolvedValue(undefined);
    spies.push(orderPins);
    const pins = [bot("a", { pinned: true, pinPosition: 0 }), bot("b", { pinned: true, pinPosition: 1 })];
    const { hook } = harness(pins);
    await act(() => hook.result.current.dropRow(
      { kind: "bot", bot: pins[1]! },
      PINNED_DROP_ID,
      { sectionId: PINNED_DROP_ID, index: 1 },
      () => pins.map((pin) => ({ kind: "bot", bot: pin })),
    ));
    expect(orderPins).not.toHaveBeenCalled();
  });

  test("glisser une section plus bas réécrit l'ordre des éditables, « Non assigné » en place", async () => {
    const orderSections = spyOn(api, "orderSections").mockResolvedValue(undefined);
    spies.push(orderSections);
    const { client, hook } = harness([]);
    // A (rang 0) posée avant l'éditable d'index 2 (C) : B, A, C.
    await act(() => hook.result.current.reorderSection("sec-a", 2, ["sec-a", "sec-b", "sec-c"]));
    expect(orderSections).toHaveBeenCalledWith({ order: ["sec-b", "sec-a", "sec-c"] });
    const positions = Object.fromEntries(client.getQueryData<RosterDto>(queryKeys.roster)!.sections.map((section) => [section.id, section.position]));
    expect(positions).toEqual({ "sec-default": 0, "sec-b": 1, "sec-a": 2, "sec-c": 3 });
  });

  test("une section reposée à sa place n'écrit rien", async () => {
    const orderSections = spyOn(api, "orderSections").mockResolvedValue(undefined);
    spies.push(orderSections);
    const { hook } = harness([]);
    await act(() => hook.result.current.reorderSection("sec-b", 2, ["sec-a", "sec-b", "sec-c"]));
    expect(orderSections).not.toHaveBeenCalled();
  });

  test("un refus du serveur relit le roster", async () => {
    const orderSections = spyOn(api, "orderSections").mockRejectedValue(new Error("409"));
    spies.push(orderSections);
    const { client, hook } = harness([]);
    const invalidate = spyOn(client, "invalidateQueries");
    spies.push(invalidate);
    await act(() => hook.result.current.reorderSection("sec-c", 0, ["sec-a", "sec-b", "sec-c"]));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.roster });
  });
});
