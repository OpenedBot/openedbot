/**
 * Point d'entrée i18n du code navigateur (console, admin).
 *
 * Les dictionnaires vivent dans `@openedbot/contracts-i18n`, aussi utilisé par le
 * worker pour traduire les notifications push. Ici, `t()` lit le seul
 * dictionnaire navigateur chargé. Les primitives de locale viennent du
 * contrat `@openedbot/contracts-locale`, également lu par l'API et le worker. Ce
 * paquet porte aussi les formats `Intl` utilisés par les écrans.
 */
export * from "@openedbot/contracts-locale";
export { activateLocale, hasMessage, isLocaleLoaded, loadLocale, registerMessages, t } from "./dictionary";
export type { MessageKey, MessagePaths, MessageTree } from "@openedbot/contracts-i18n";
export * from "./format";
export * from "./locale-detect";
