import { DEFAULT_LOCALE, isLocale, type Locale } from "@openedbot/contracts-locale";

/**
 * Choix de la langue de l'interface web (console et backoffice), une seule
 * règle pour la clé `ohb:locale`, partagée aussi avec le site public.
 *
 * Au montage : une préférence valide enregistrée dans `localStorage` gagne,
 * sinon la première langue prise en charge dans `navigator.languages` est
 * retenue. `navigator.language` puis `DEFAULT_LOCALE` servent de recours. La
 * langue devinée n'est pas persistée : elle doit pouvoir suivre un autre
 * navigateur tant que la personne n'a pas choisi de préférence.
 */
export const LOCALE_STORAGE_KEY = "ohb:locale";

/** Fonction pure : `stored` est la valeur brute de `localStorage`, `languages` la liste du navigateur. */
export function resolveInitialLocale(
  stored: string | null | undefined,
  languages: readonly (string | null | undefined)[],
): Locale {
  if (isLocale(stored)) return stored;
  for (const candidate of languages) {
    const language = candidate?.toLowerCase().split("-")[0];
    if (isLocale(language)) return language;
  }
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): Locale | null {
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(raw)) return raw;
  } catch {
    // Une préférence inaccessible ne doit pas empêcher la langue du navigateur.
  }
  return null;
}

function readBrowserLanguages(): string[] {
  try {
    if (typeof navigator !== "undefined") {
      return [...(navigator.languages ?? []), navigator.language];
    }
  } catch {
    // Un navigateur inaccessible ne doit pas faire échouer le rendu hors navigateur.
  }
  return [];
}

/** Langue au montage : préférence enregistrée, sinon langue du navigateur. */
export function readInitialLocale(): Locale {
  return resolveInitialLocale(readStoredLocale(), readBrowserLanguages());
}

export function writeStoredLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Une langue qui ne persiste pas est une préférence perdue, pas une app cassée.
  }
}
