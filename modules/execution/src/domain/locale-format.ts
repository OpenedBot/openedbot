import { t as translate } from "@openedbot/contracts-i18n";
import { routineGateText } from "@openedbot/contracts-i18n/server";
import type { Locale } from "@openedbot/contracts-locale";
import type { GateTextFormat } from "./routine-gate-text";

const INTL_LOCALE: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

/**
 * The server's translator and formats for one locale, the same as the
 * console's (`@openedbot/browser-i18n`). Server only: it loads every
 * dictionary.
 */
export function localeFormat(locale: Locale): GateTextFormat {
  return {
    t: (key, params) => translate(locale, key, params),
    gate: (key, params) => routineGateText(locale, key, params),
    formatDate: (value, options) => new Intl.DateTimeFormat(INTL_LOCALE[locale], options ?? { dateStyle: "medium", timeStyle: "short" }).format(value),
    formatNumber: (value, options) => new Intl.NumberFormat(INTL_LOCALE[locale], options).format(value),
  };
}
