import { describe, expect, test } from "bun:test";
import type { SectionDto } from "@openedbot/contracts-api";
import { defaultSectionId, projectRosterSections, rosterSectionMoveState } from "../src/domain/roster-sections";

const section = (id: string, position: number, extra: Partial<SectionDto> = {}): SectionDto =>
  ({ id, name: id, position, collapsed: false, ...extra });
const row = (id: string, sectionId: string) => ({ id, sectionId });
const sectionIdOf = (item: { sectionId: string }) => item.sectionId;

describe("projectRosterSections", () => {
  test("la section par défaut est la première par rang, quel que soit l'ordre reçu", () => {
    expect(defaultSectionId([section("b", 3), section("a", 1), section("c", 2)])).toBe("a");
    expect(defaultSectionId([])).toBeNull();
  });

  test("sans aucune section, il n'y a rien à lister, pas de section fantôme sans id", () => {
    const projection = projectRosterSections({ sections: [], rows: [row("x", "default")], sectionIdOf });
    expect(projection).toEqual({ flat: true, defaultSectionId: null, sections: [] });
  });

  test("sans section éditable, la liste reste plate et garde l'ordre des lignes", () => {
    const projection = projectRosterSections({
      sections: [section("default", 0)],
      rows: [row("x", "default"), row("y", "default")],
      sectionIdOf,
    });
    expect(projection.flat).toBe(true);
    expect(projection.sections).toHaveLength(1);
    expect(projection.sections[0]?.rows.map((item) => item.id)).toEqual(["x", "y"]);
    expect(projection.sections[0]?.locked).toBe(true);
  });

  test("les sections éditables par rang, puis la section par défaut verrouillée en dernier", () => {
    const projection = projectRosterSections({
      sections: [section("default", 0, { collapsed: true }), section("ship", 2, { name: "Shipper" }), section("leads", 1)],
      rows: [row("a", "ship"), row("b", "default"), row("c", "leads"), row("d", "gone")],
      sectionIdOf,
    });
    expect(projection.flat).toBe(false);
    expect(projection.sections.map((item) => item.id)).toEqual(["leads", "ship", "default"]);
    expect(projection.sections.map((item) => item.locked)).toEqual([false, false, true]);
    // Une ligne d'une section disparue retombe dans la section par défaut ;
    // celle-ci se replie comme les autres quand la base le dit.
    expect(projection.sections[2]?.rows.map((item) => item.id)).toEqual(["b", "d"]);
    expect(projection.sections[2]?.collapsed).toBe(true);
    // Une section éditable vide reste rendue : c'est la cible d'un dépôt.
    expect(projection.sections[1]?.rows.map((item) => item.id)).toEqual(["a"]);
  });
});

describe("projectRosterSections: rang manuel", () => {
  test("avec `positionOf`, les lignes d'une section suivent leur rang, à égalité l'ordre reçu", () => {
    const rows = [
      { id: "c", sectionId: "a", position: 2 },
      { id: "b", sectionId: "a", position: 0 },
      { id: "d", sectionId: "a", position: 0 },
      { id: "x", sectionId: "default", position: 5 },
      { id: "y", sectionId: "default", position: 1 },
    ];
    const projection = projectRosterSections({
      sections: [section("default", 0), section("a", 1)],
      rows,
      sectionIdOf,
      positionOf: (row) => row.position,
    });
    expect(projection.sections.map((item) => item.rows.map((row) => row.id))).toEqual([["b", "d", "c"], ["y", "x"]]);
    const flat = projectRosterSections({ sections: [section("default", 0)], rows: rows.slice(3), sectionIdOf, positionOf: (row) => row.position });
    expect(flat.sections[0]?.rows.map((row) => row.id)).toEqual(["y", "x"]);
  });
});

describe("rosterSectionMoveState", () => {
  const projection = projectRosterSections({
    sections: [section("default", 0), section("a", 1), section("b", 2), section("c", 5)],
    rows: [],
    sectionIdOf,
  });

  test("monter ou descendre échange avec la voisine éditable, jamais avec la section par défaut", () => {
    expect(rosterSectionMoveState(projection.sections, "a")).toEqual({
      canMoveUp: false, canMoveDown: true, upPosition: null, downPosition: 2,
    });
    expect(rosterSectionMoveState(projection.sections, "b")).toEqual({
      canMoveUp: true, canMoveDown: true, upPosition: 1, downPosition: 5,
    });
    expect(rosterSectionMoveState(projection.sections, "c").canMoveDown).toBe(false);
    expect(rosterSectionMoveState(projection.sections, "default")).toEqual({
      canMoveUp: false, canMoveDown: false, upPosition: null, downPosition: null,
    });
  });
});
