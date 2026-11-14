/**
 * Locale contract: the product's two languages, the language served by
 * default, the dictionary's fallback language and their normalization. Pure, with no
 * dictionary: the server imports it without loading the messages.
 */

export type Locale = "fr" | "en";

/**
 * The language served to whoever has expressed no preference: English.
 *
 * French stays the dictionary's REFERENCE language (`messages.fr.ts`
 * is the file whose keys are authoritative, and the fallback of `t()` when a string
 * is missing in English): these are two distinct roles, and only the second changes
 * here. A person who has already chosen their language keeps that choice, it lives in
 * `localStorage` (`openedbot:locale`).
 */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * The REFERENCE dictionary, distinct from the default above.
 *
 * `messages.fr.ts` is the file whose keys are authoritative (`MessageKey` is
 * derived from it) and the one `t()` falls back to when a string is missing elsewhere,
 * as US-I18N-01 requires. This role has nothing to do with « the language served
 * by default »: confusing the two would mean that switching the default would
 * also change the fallback language, and a key missing in English
 * would fall back to itself instead of French.
 */
export const FALLBACK_LOCALE: Locale = "fr";
export const LOCALES: readonly Locale[] = ["fr", "en"];

/**
 * Detects the locale from a BCP-47 string (`navigator.language`, Expo
 * locale, `Accept-Language`…). The product speaks only two languages: any
 * other declaration (`de-DE`, `es-ES`) falls back to `DEFAULT_LOCALE`, therefore
 * English, and not to the reference dictionary.
 */
export function detectLocale(source: string | null | undefined): Locale {
  if (!source) return DEFAULT_LOCALE;
  const lower = source.toLowerCase();
  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("fr")) return "fr";
  return DEFAULT_LOCALE;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Coerces any input to a valid locale, falling back to the default language. */
export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
