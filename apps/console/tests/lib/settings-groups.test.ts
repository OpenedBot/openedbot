import { describe, expect, test } from "bun:test";
import { SETTINGS_GROUPS, isSettingsEntryActive } from "../../src/components/dashboard/settings-sidebar";

const items = () => SETTINGS_GROUPS.flatMap((group) => group.items);

describe("menu des réglages, rangé par besoin", () => {
  test("Moi, Espace de travail, Bots et runtime, Contrôle, dans cet ordre", () => {
    expect(SETTINGS_GROUPS.map((group) => group.labelKey).filter((key) => key !== "settingsSidebar.groupDev")).toEqual([
      "settingsSidebar.groupMe",
      "settingsSidebar.groupWorkspace",
      "settingsSidebar.groupBots",
      "settingsSidebar.groupControl",
    ]);
  });

  test("les notifications personnelles sont accessibles, sans entrée grisée", () => {
    expect(items().some((item) => item.disabled)).toBe(false);
    expect(items().some((item) => item.url === "/settings/notifications")).toBe(true);
  });

  test("« Importer des agents » n'est pas une entrée, sa page allume Runtime", () => {
    expect(items().some((item) => item.url === "/settings/agents")).toBe(false);
    const runtime = items().find((item) => item.url === "/settings/runtime");
    expect(runtime?.also).toContain("/settings/agents");
    expect(runtime?.also?.some((url) => isSettingsEntryActive("/settings/agents", url))).toBe(true);
  });

  test("chaque rubrique n'apparaît qu'une fois", () => {
    const urls = items().map((item) => item.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
