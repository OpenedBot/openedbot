import { describe, expect, test } from "bun:test";
import { isSupportLauncherVisible, isSupportPage, SUPPORT_ROUTE_ID } from "../../src/lib/support-launcher-visibility";

describe("visibilité de la bulle du guichet", () => {
  test("se montre hors de l'application : connexion, légal, onboarding", () => {
    for (const routeIds of [["__root__", "/login"], ["__root__", "/legal/$slug"], ["__root__", "/onboarding"]]) {
      expect(isSupportLauncherVisible(routeIds, false)).toBe(true);
    }
  });

  test("se retire de la coque et des réglages : la porte est dans l'en-tête", () => {
    // Le guichet y reste atteignable par `SiteHeader`
    // (`support-header-button.tsx`), qui mène à la page `/support`.
    for (const routeIds of [["__root__", "/_app", "/_app/"], ["__root__", "/_app", "/_app/bot/$botId"], ["__root__", "/_app", SUPPORT_ROUTE_ID], ["__root__", "/settings", "/settings/models"], ["__root__", "/fleet"], ["__root__", "/fleets"]]) {
      expect(isSupportLauncherVisible(routeIds, false)).toBe(false);
    }
  });

  test("la page du guichet se reconnaît, et seulement elle", () => {
    expect(isSupportPage(["__root__", "/_app", SUPPORT_ROUTE_ID])).toBe(true);
    expect(isSupportPage(["__root__", "/_app", "/_app/bot/$botId"])).toBe(false);
  });

  test("la page publique garde la bulle, bien que montée par la coque", () => {
    expect(isSupportLauncherVisible(["__root__", "/_app", "/_app/"], true)).toBe(true);
  });
});
