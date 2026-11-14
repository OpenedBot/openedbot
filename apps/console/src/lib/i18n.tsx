/**
 * Language of the web interface: the provider and the language-choice rule
 * (saved preference, then `navigator.languages`) live in
 * `@openedbot/browser-i18n`, shared with the backoffice.
 */
export { I18nProvider, LOCALE_STORAGE_KEY, useFallbackT, useT } from "@openedbot/browser-i18n/provider";
export type { Locale, MessageKey } from "@openedbot/browser-i18n";
