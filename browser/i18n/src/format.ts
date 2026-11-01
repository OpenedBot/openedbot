import type { Locale } from "@openedbot/contracts-locale";
import { t } from "./dictionary";
import type { MessageKey } from "@openedbot/contracts-i18n";

/**
 * Pluriel à deux formes. Règle simplifiée mais correcte pour le français et
 * l'anglais : le français traite 0 et 1 comme singulier, l'anglais uniquement
 * 1 ; le reste des locales n'existe pas dans ce produit.
 */
export function plural(
  locale: Locale,
  count: number,
  forms: { one: string; other: string },
): string {
  const isOne = locale === "fr" ? count === 0 || count === 1 : count === 1;
  return (isOne ? forms.one : forms.other).replaceAll("{count}", String(count));
}

const INTL_LOCALE: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

/**
 * Remplace les appels `toLocaleString("fr-FR")` / `Intl.DateTimeFormat("fr-FR")`
 * en dur (`screens/settings/decisions.tsx`, `components/settings/primitives.tsx:200`
 * avant ce lot) par une locale qui suit le réglage utilisateur.
 */
export function formatDate(
  locale: Locale,
  value: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (value === null || value === undefined || value === "") return t(locale, "common.never");
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat(
    INTL_LOCALE[locale],
    options ?? { dateStyle: "medium", timeStyle: "short" },
  ).format(date);
}

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], options).format(value);
}

/** La base 1024 suit celle des quotas enregistrés. */
export function formatBytes(locale: Locale, value: number): string {
  const units = [
    "units.byte",
    "units.kibibyte",
    "units.mebibyte",
    "units.gibibyte",
    "units.tebibyte",
  ] as const;
  if (!Number.isFinite(value) || value <= 0) return `0 ${t(locale, "units.byte")}`;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = size >= 100 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${formatNumber(locale, rounded)} ${t(locale, units[unit] ?? "units.byte")}`;
}

/**
 * L'âge d'un fait (une vérification, une lecture, une activité) : « il y a 3 j ».
 * `null` se lit « jamais ». Les libellés viennent du dictionnaire
 * (`relativeTime.*`), donc suivent la langue.
 */
export function ageSince(locale: Locale, value: string | null): string {
  if (!value) return t(locale, "relativeTime.never");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return relativeTime(locale, "relativeTime.seconds", seconds);
  if (seconds < 3600) {
    return relativeTime(locale, "relativeTime.minutes", Math.round(seconds / 60));
  }
  if (seconds < 86_400) {
    return relativeTime(locale, "relativeTime.hours", Math.round(seconds / 3600));
  }
  return relativeTime(locale, "relativeTime.days", Math.round(seconds / 86_400));
}

/**
 * L'heure courte d'une ligne de liste (dernière activité d'un fil), comme une
 * messagerie : « 17:02 » aujourd'hui, « hier », le jour de la semaine dans les
 * six derniers jours (« lun. »), sinon une date courte (« 12 oct. », l'année
 * en plus hors de l'année en cours). Les mots viennent d'`Intl`, donc suivent
 * la langue sans clé de dictionnaire. `null` ou une date illisible : vide.
 */
export function formatListTime(locale: Locale, value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const lang = INTL_LOCALE[locale];
  const startOfDay = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  // Jours calendaires, pas tranches de 24 h : 23:50 hier, lu à 00:10, est « hier ».
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit" }).format(date);
  if (days === 1) return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(-1, "day");
  if (days < 7) return new Intl.DateTimeFormat(lang, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(
    lang,
    date.getFullYear() === now.getFullYear()
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" },
  ).format(date);
}

function relativeTime(locale: Locale, key: MessageKey, count: number): string {
  return t(locale, key, { count: formatNumber(locale, count) });
}

/** Deux lettres au plus (un nom, ou une adresse e-mail découpée sur `@ . _ -`). */
export function initials(value: string): string {
  const parts = value.trim().split(/[\s@._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? parts[1]?.[0] ?? "" : "";
  return `${first}${second}`.toUpperCase();
}
