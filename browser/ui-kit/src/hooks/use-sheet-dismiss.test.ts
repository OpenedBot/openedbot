import { describe, expect, test } from "bun:test";
import {
  decideSheetDismiss,
  SHEET_DRAG_SLOP,
  sheetDragCaptures,
} from "./use-sheet-dismiss";

/**
 * La géométrie du balayage vers le bas, hors React : c'est elle qui décide si
 * la feuille se referme, et elle doit décider pareil que le tiroir et que la
 * pile in-sheet, dont elle reprend les seuils.
 */
describe("le doigt capture-t-il la feuille", () => {
  test("un geste vers le bas, franc et vertical, capture", () => {
    expect(sheetDragCaptures({ dx: 0, dy: SHEET_DRAG_SLOP + 1 })).toBe(true);
    expect(sheetDragCaptures({ dx: 4, dy: 40 })).toBe(true);
  });

  test("un geste vers le haut ne capture jamais, c'est un scroll", () => {
    expect(sheetDragCaptures({ dx: 0, dy: -40 })).toBe(false);
  });

  test("sous le slop, le doigt n'a encore rien choisi", () => {
    expect(sheetDragCaptures({ dx: 0, dy: SHEET_DRAG_SLOP })).toBe(false);
  });

  test("plus horizontal que vertical : le doigt appartient au pop in-sheet", () => {
    expect(sheetDragCaptures({ dx: 60, dy: 30 })).toBe(false);
    expect(sheetDragCaptures({ dx: -60, dy: 30 })).toBe(false);
  });
});

describe("la feuille se referme-t-elle au relâchement", () => {
  const height = 800;

  test("un quart de la hauteur suffit, sans vitesse", () => {
    expect(decideSheetDismiss({ offset: 201, height, velocity: 0 })).toBe(true);
    expect(decideSheetDismiss({ offset: 199, height, velocity: 0 })).toBe(false);
  });

  test("un lancer referme même sur une course courte", () => {
    expect(decideSheetDismiss({ offset: 40, height, velocity: 0.9 })).toBe(true);
  });

  test("un retour franc vers le haut annule une course encore basse", () => {
    expect(decideSheetDismiss({ offset: 120, height, velocity: -0.9 })).toBe(false);
  });

  test("mais un jitter vers le haut ne ramène pas une feuille déjà sortie aux trois quarts", () => {
    expect(decideSheetDismiss({ offset: 600, height, velocity: -0.9 })).toBe(true);
  });
});
