import { describe, expect, test } from "bun:test";
import { browserTitleEntity, browserTitleKey, formatBrowserTitle } from "../../src/lib/browser-title";

describe("browser tab metadata", () => {
  test("maps the main desktop destinations to their translated navigation label", () => {
    expect(browserTitleKey("/")).toBe("overviewPlaceholder.nav");
    expect(browserTitleKey("/inbox")).toBe("inbox.title");
    expect(browserTitleKey("/settings/runtime")).toBe("settingsSidebar.runtime");
    expect(browserTitleKey("/settings/security/")).toBe("settingsSidebar.security");
    expect(browserTitleKey("/legal/privacy")).toBe("legal.privacy");
  });

  test("gives the legacy conversation link its own title instead of falling back to the bare app name", () => {
    expect(browserTitleKey("/c/some-old-slug")).toBe("conversation.botGone");
    expect(browserTitleEntity("/c/some-old-slug")).toBeNull();
  });

  test("extracts dynamic bot and group identities without presenting their ids", () => {
    expect(browserTitleEntity("/bot/bot-42")).toEqual({ kind: "bot", id: "bot-42" });
    expect(browserTitleEntity("/g/salon%20produit")).toEqual({ kind: "group", id: "salon produit" });
    expect(browserTitleEntity("/bot/%invalid")).toBeNull();
    expect(browserTitleEntity("/settings/runtime")).toBeNull();
    expect(browserTitleKey("/bot/bot-42")).toBeNull();
  });

  test("keeps openedbot as a stable, compact suffix", () => {
    expect(formatBrowserTitle("Scout")).toBe("Scout · openedbot");
    expect(formatBrowserTitle("  Sécurité  ")).toBe("Sécurité · openedbot");
    expect(formatBrowserTitle(null)).toBe("openedbot");
  });
});
