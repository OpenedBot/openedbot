import { DEFAULT_LOCALE, formatDate as formatDateI18n, t, type Locale } from "@openedbot/browser-i18n";

/** `fr-FR`/`en-US` : la même correspondance que le socle i18n, locale au sens `Intl`. */
const INTL_LOCALE: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

/**
 * Palettes des avatars, dans l'esprit de la capture : un dégradé saturé par
 * bot, stable dans le temps.
 *
 * Une liste fixe plutôt qu'un HSL calculé : les teintes tirées au hasard
 * tombent régulièrement sur des bruns ou des kakis, et deux bots voisins
 * finissent indiscernables.
 */
const GRADIENTS = [
  "from-teal-400 to-emerald-600",
  "from-amber-400 to-orange-600",
  "from-violet-400 to-indigo-600",
  "from-sky-400 to-blue-600",
  "from-rose-400 to-pink-600",
  "from-lime-400 to-green-600",
  "from-fuchsia-400 to-purple-600",
  "from-cyan-400 to-teal-600",
] as const;

/**
 * Hachage déterministe : le même bot garde sa couleur d'un lancement à
 * l'autre, et d'une machine à l'autre. Un compteur d'ordre d'affichage ne
 * tiendrait pas : la liste se réordonne à chaque message.
 */
export function gradientFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0;
  }
  return GRADIENTS[hash % GRADIENTS.length]!;
}

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

/** L'heure d'un message dans le fil. */
export function messageTime(value: string | Date, locale: Locale = DEFAULT_LOCALE): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(INTL_LOCALE[locale], { hour: "numeric", minute: "2-digit" });
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
