import { describe, expect, test } from "bun:test";
import { DEFAULT_LOCALE, FALLBACK_LOCALE, detectLocale, normalizeLocale } from "@openedbot/contracts-locale";
import { t } from "../src/index";

/**
 * The two roles this module distinguishes, and that would be easy to
 * conflate again: the language SERVED to whoever has chosen nothing (English), and the
 * REFERENCE dictionary `t()` falls back to when a string is missing
 * (French, US-I18N-01).
 */
describe("langue par défaut", () => {
  test("un visiteur sans préférence est servi en anglais", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
    expect(normalizeLocale("klingon")).toBe("en");
  });

  test("le dictionnaire de repli reste le français", () => {
    expect(FALLBACK_LOCALE).toBe("fr");
  });

  test("une langue explicite gagne toujours sur le défaut", () => {
    expect(normalizeLocale("fr")).toBe("fr");
    expect(detectLocale("fr-FR")).toBe("fr");
    expect(detectLocale("en-GB")).toBe("en");
    // A language the product does not speak falls back to the default, not to the fallback.
    expect(detectLocale("de-DE")).toBe("en");
    expect(detectLocale(null)).toBe("en");
  });

  test("t() rend bien la langue demandée, dans les deux sens", () => {
    expect(t("en", "common.close")).not.toBe("common.close");
    expect(t("fr", "common.close")).not.toBe("common.close");
    expect(t("en", "common.close")).not.toBe(t("fr", "common.close"));
  });
});
