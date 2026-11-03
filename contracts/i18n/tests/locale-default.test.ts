import { describe, expect, test } from "bun:test";
import { DEFAULT_LOCALE, FALLBACK_LOCALE, detectLocale, normalizeLocale } from "@openedbot/contracts-locale";
import { t } from "../src/index";

/**
 * Les deux rôles que ce module distingue, et qu'il serait facile de
 * reconfondre : la langue SERVIE à qui n'a rien choisi (anglais), et le
 * dictionnaire de RÉFÉRENCE sur lequel `t()` retombe quand une chaîne manque
 * (français, US-I18N-01).
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
    // Une langue que le produit ne parle pas retombe sur le défaut, pas sur le repli.
    expect(detectLocale("de-DE")).toBe("en");
    expect(detectLocale(null)).toBe("en");
  });

  test("t() rend bien la langue demandée, dans les deux sens", () => {
    expect(t("en", "common.close")).not.toBe("common.close");
    expect(t("fr", "common.close")).not.toBe("common.close");
    expect(t("en", "common.close")).not.toBe(t("fr", "common.close"));
  });
});
