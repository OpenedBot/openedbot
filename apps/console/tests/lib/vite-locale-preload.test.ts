import { afterEach, describe, expect, test } from "bun:test";
import { LOCALE_STORAGE_KEY, resolveInitialLocale } from "@openedbot/browser-i18n";
import { localePreloadScript, STORED_LOCALE_KEY } from "../../vite-locale-preload";

const FILES = { fr: "/assets/messages.fr-AAAA.js", en: "/assets/messages.en-BBBB.js" } as const;

/** Runs the inline script against a stored value and browser languages; returns the preloaded href. */
function preloaded(stored: string | null, languages: string[], language: string | undefined): string | null {
  const head = document.head;
  for (const link of head.querySelectorAll('link[rel="modulepreload"]')) link.remove();
  if (stored === null) localStorage.removeItem(STORED_LOCALE_KEY);
  else localStorage.setItem(STORED_LOCALE_KEY, stored);
  Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
  Object.defineProperty(navigator, "language", { value: language, configurable: true });
  new Function(localePreloadScript(FILES))();
  const link = head.querySelector<HTMLLinkElement>('link[rel="modulepreload"]');
  return link?.getAttribute("href") ?? null;
}

afterEach(() => localStorage.removeItem(STORED_LOCALE_KEY));

describe("préchargement du dictionnaire", () => {
  test("même clé de stockage que la console", () => {
    expect(STORED_LOCALE_KEY).toBe(LOCALE_STORAGE_KEY);
  });

  const cases: Array<[string | null, string[], string | undefined]> = [
    [null, [], undefined],
    [null, ["fr-FR", "en-US"], "fr-FR"],
    [null, ["de-DE", "en-GB"], "de-DE"],
    [null, ["de-DE"], "fr-CA"],
    [null, ["es"], "it"],
    ["en", ["fr-FR"], "fr-FR"],
    ["fr", ["en-US"], "en-US"],
    ["de", ["en-US"], "en-US"],
    ["", ["FR"], "FR"],
  ];
  for (const [stored, languages, language] of cases) {
    test(`stocké ${JSON.stringify(stored)}, navigateur ${JSON.stringify(languages)} / ${language} : la langue de resolveInitialLocale`, () => {
      const expected = resolveInitialLocale(stored, [...languages, language]);
      expect(preloaded(stored, languages, language)).toBe(FILES[expected]);
    });
  }
});
