import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSupportPanel,
  isSupportPanelOpen,
  openSupportPanel,
} from "../../../src/lib/support/support-panel-session";

afterEach(() => {
  closeSupportPanel();
});

describe("l’état du canva du guichet", () => {
  test("s’ouvre et se referme", () => {
    expect(isSupportPanelOpen()).toBe(false);
    openSupportPanel();
    expect(isSupportPanelOpen()).toBe(true);
    closeSupportPanel();
    expect(isSupportPanelOpen()).toBe(false);
  });

  test("deux ouvertures ne donnent qu’un canva", () => {
    // Deux portes commandent le même panneau : la bulle et le bouton
    // d'en-tête. Deux canvas superposés porteraient deux fois le même fil et
    // deux flux SSE pour le même jeton.
    openSupportPanel();
    openSupportPanel();
    expect(isSupportPanelOpen()).toBe(true);
    closeSupportPanel();
    expect(isSupportPanelOpen()).toBe(false);
  });

  test("refermer un canva déjà fermé ne fait rien", () => {
    closeSupportPanel();
    expect(isSupportPanelOpen()).toBe(false);
  });
});
