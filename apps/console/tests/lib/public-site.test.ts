import { describe, expect, test } from "bun:test";
import { publicSiteUrl } from "../../src/lib/public-site";

describe("publicSiteUrl", () => {
  test("vide ou absent : pas de site public (instance solo)", () => {
    expect(publicSiteUrl("")).toBeNull();
    expect(publicSiteUrl("   ")).toBeNull();
    expect(publicSiteUrl(undefined)).toBeNull();
  });

  test("une adresse https, sans / final", () => {
    expect(publicSiteUrl("https://openedbot.app")).toBe("https://openedbot.app");
    expect(publicSiteUrl("https://openedbot.app/")).toBe("https://openedbot.app");
    expect(publicSiteUrl(" https://example.test/site/ ")).toBe("https://example.test/site");
  });

  test("refuse ce qui n'est pas une adresse http(s) simple", () => {
    expect(publicSiteUrl("javascript:alert(1)")).toBeNull();
    expect(publicSiteUrl("openedbot.app")).toBeNull();
    expect(publicSiteUrl("https://user:pw@openedbot.app")).toBeNull();
    expect(publicSiteUrl("https://openedbot.app/?x=1")).toBeNull();
  });

  test("ne dépend pas de l'hôte qui sert la console", () => {
    const original = globalThis.window?.__OHB_PUBLIC_SITE_URL__;
    if (!globalThis.window) return;
    window.__OHB_PUBLIC_SITE_URL__ = "https://openedbot.app";
    try {
      expect(publicSiteUrl()).toBe("https://openedbot.app");
    } finally {
      window.__OHB_PUBLIC_SITE_URL__ = original;
    }
  });
});
