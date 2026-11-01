import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { DEFAULT_LOCALE } from "@openedbot/contracts-locale";
import { I18nProvider, LOCALE_STORAGE_KEY, useT } from "../../src/lib/i18n";

const originalLanguage = navigator.language;
const originalLanguages = navigator.languages;
const originalStoredLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);

function LocaleProbe() {
  return <output>{useT().locale}</output>;
}

function renderLocale() {
  return render(
    <I18nProvider>
      <LocaleProbe />
    </I18nProvider>,
  );
}

function setNavigatorLanguage(language: string) {
  Object.defineProperty(navigator, "language", {
    configurable: true,
    value: language,
  });
}

function setNavigatorLanguages(languages: readonly string[]) {
  Object.defineProperty(navigator, "languages", {
    configurable: true,
    value: languages,
  });
}

afterEach(() => {
  cleanup();
  if (originalStoredLocale === null) window.localStorage.removeItem(LOCALE_STORAGE_KEY);
  else window.localStorage.setItem(LOCALE_STORAGE_KEY, originalStoredLocale);
  setNavigatorLanguage(originalLanguage);
  setNavigatorLanguages(originalLanguages);
});

beforeEach(() => {
  window.localStorage.removeItem(LOCALE_STORAGE_KEY);
  setNavigatorLanguages([]);
});

describe("I18nProvider", () => {
  test("sans préférence, suit un navigateur français", async () => {
    setNavigatorLanguage("fr-FR");

    renderLocale();

    expect(await screen.findByText("fr")).toBeTruthy();
  });

  test("sans préférence, retombe sur la locale par défaut pour une langue inconnue", async () => {
    setNavigatorLanguage("de-DE");

    renderLocale();

    expect(await screen.findByText(DEFAULT_LOCALE)).toBeTruthy();
  });

  test("une préférence enregistrée gagne sur la langue du navigateur", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
    setNavigatorLanguage("en-US");

    renderLocale();

    expect(await screen.findByText("fr")).toBeTruthy();
  });

  test("la résolution seule n'écrit pas dans localStorage", async () => {
    setNavigatorLanguage("fr-FR");

    renderLocale();

    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });
});

describe("préférences de langue du navigateur", () => {
  test.each([
    [["fr-FR", "en-US"], "fr"],
    [["de-DE", "fr-CA", "en-US"], "fr"],
    [["en-US", "fr-FR"], "en"],
    [["FR-ca"], "fr"],
    [["de-DE", "es-ES"], "en"],
  ] as const)("respecte l'ordre de %j", async (languages, expected) => {
    setNavigatorLanguage(languages[0]);
    setNavigatorLanguages(languages);
    renderLocale();
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });

  test("ignore une préférence stockée invalide", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "invalid");
    setNavigatorLanguage("fr-FR");
    setNavigatorLanguages(["fr-FR", "en"]);
    renderLocale();
    expect(await screen.findByText("fr")).toBeTruthy();
  });

  test("préserve un choix anglais explicite sur un navigateur français", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    setNavigatorLanguage("fr-FR");
    setNavigatorLanguages(["fr-FR"]);
    renderLocale();
    expect(await screen.findByText("en")).toBeTruthy();
  });
});
