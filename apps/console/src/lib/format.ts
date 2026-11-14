import { DEFAULT_LOCALE, formatDate as formatDateI18n, t, type Locale } from "@openedbot/browser-i18n";

/** `fr-FR`/`en-US`: the same mapping as the i18n base, locale in the `Intl` sense. */
const INTL_LOCALE: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The list timestamp, as the capture shows it: a time for
 * today, « Hier », then a weekday, then a date.
 *
 * Deliberately no « il y a 3 min »: that forces re-rendering the list
 * continuously to stay exact, whereas a fixed time reads just as well.
 */
export function listTimestamp(
  iso: string,
  now = new Date(),
  locale: Locale = DEFAULT_LOCALE,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const elapsedDays = Math.floor((startOfToday.getTime() - date.getTime()) / (24 * HOUR));

  if (date >= startOfToday) {
    // `2-digit` on the hour: in French the hour is written « 00:59 », not
    // « 0:59 », and a fixed-width column does not dance between 9 h and 10 h.
    return date.toLocaleTimeString(INTL_LOCALE[locale], { hour: "2-digit", minute: "2-digit" });
  }
  if (elapsedDays < 1) return t(locale, "format.yesterday");
  if (elapsedDays < 6) return date.toLocaleDateString(INTL_LOCALE[locale], { weekday: "short" });
  return date.toLocaleDateString(INTL_LOCALE[locale], { day: "numeric", month: "short" });
}

/**
 * `locale` defaulting to "fr": screens that have not yet been
 * wired to `useT()` keep displaying exactly as before. It is
 * the default parameter, not a copied `Intl.DateTimeFormat("fr-FR", …)`,
 * that makes the screen independent of the active language.
 */
export function formatDate(value: string | null | undefined, locale: Locale = "fr"): string {
  return formatDateI18n(locale, value);
}

/** Clamps `value` between `min` and `max`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Comparable form of a spoken answer to a choice: no case, no
 * trailing punctuation, collapsed spaces (« Oui. » equals « oui »).
 */
export function normalizeChoice(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/[.!?…]+$/u, "")
    .replace(/\s+/g, " ");
}
