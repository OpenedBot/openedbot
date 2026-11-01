import { describe, expect, test } from "bun:test";
import { SHOW_DEV_SETTINGS } from "../../src/lib/dev-settings-ui";
import { SETTINGS_GROUPS } from "../../src/components/dashboard/settings-sidebar";

const urls = () => SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => item.url));

describe("SHOW_DEV_SETTINGS", () => {
  test("n'est vrai que pour le booléen Vite import.meta.env.DEV", () => {
    expect(SHOW_DEV_SETTINGS).toBe(import.meta.env.DEV === true);
  });
});

describe("groupe Développement", () => {
  test("n'expose Facturation et Outils de dev que quand SHOW_DEV_SETTINGS est vrai", () => {
    expect(urls().includes("/settings/billing")).toBe(SHOW_DEV_SETTINGS);
    expect(urls().includes("/settings/developer")).toBe(SHOW_DEV_SETTINGS);
  });

  test("rassemble tout le dev dans un seul groupe, jamais dans un groupe produit", () => {
    const product = SETTINGS_GROUPS.filter((group) => group.labelKey !== "settingsSidebar.groupDev");
    expect(product.some((group) => group.items.some((item) => item.url === "/settings/billing" || item.url === "/settings/developer"))).toBe(false);
    const dev = SETTINGS_GROUPS.find((group) => group.labelKey === "settingsSidebar.groupDev");
    expect(dev === undefined).toBe(!SHOW_DEV_SETTINGS);
    if (dev) expect(dev.items.map((item) => item.url)).toEqual(["/settings/billing", "/settings/developer"]);
  });
});
