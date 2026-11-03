import { DEFAULT_LOCALE, formatDate as formatDateI18n, t, type Locale } from "@openedbot/browser-i18n";

/** `fr-FR`/`en-US` : la même correspondance que le socle i18n, locale au sens `Intl`. */
const INTL_LOCALE: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * L'horodatage de la liste, tel que la capture le montre : une heure pour
 * aujourd'hui, « Hier », puis un jour de semaine, puis une date.
 *
 * Volontairement pas de « il y a 3 min » : ça oblige à re-rendre la liste en
 * continu pour rester exact, alors qu'une heure fixe se lit aussi bien.
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
    // `2-digit` sur l'heure : en français l'heure s'écrit « 00:59 », pas
    // « 0:59 », et une colonne de largeur fixe ne danse pas entre 9 h et 10 h.
    return date.toLocaleTimeString(INTL_LOCALE[locale], { hour: "2-digit", minute: "2-digit" });
  }
  if (elapsedDays < 1) return t(locale, "format.yesterday");
  if (elapsedDays < 6) return date.toLocaleDateString(INTL_LOCALE[locale], { weekday: "short" });
  return date.toLocaleDateString(INTL_LOCALE[locale], { day: "numeric", month: "short" });
}

/**
 * `locale` par défaut à "fr" : les écrans qui n'ont pas encore été
 * raccordés à `useT()` continuent de s'afficher exactement comme avant. C'est
 * le paramètre par défaut, pas un `Intl.DateTimeFormat("fr-FR", …)` recopié,
 * qui rend l'écran indépendant de la langue active.
 */
export function formatDate(value: string | null | undefined, locale: Locale = "fr"): string {
  return formatDateI18n(locale, value);
}

/** Borne `value` entre `min` et `max`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Forme comparable d'une réponse vocale à un choix : sans casse, sans
 * ponctuation finale, espaces écrasés (« Oui. » vaut « oui »).
 */
export function normalizeChoice(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/[.!?…]+$/u, "")
    .replace(/\s+/g, " ");
}
