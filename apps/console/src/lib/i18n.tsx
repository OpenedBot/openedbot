/**
 * Langue de l'interface web : le provider et la règle de choix de la langue
 * (préférence enregistrée, puis `navigator.languages`) vivent dans
 * `@openedbot/browser-i18n`, partagés avec le backoffice.
 */
export { I18nProvider, LOCALE_STORAGE_KEY, useFallbackT, useT } from "@openedbot/browser-i18n/provider";
export type { Locale, MessageKey } from "@openedbot/browser-i18n";
