import { FALLBACK_LOCALE, type Locale } from "@openedbot/contracts-locale";
import type { MessageKey } from "@openedbot/contracts-i18n";

type MessageTree = { readonly [key: string]: string | MessageTree };

const dictionaries: Partial<Record<Locale, MessageTree>> = {};
/**
 * Strings a console module brings with it (the screens of an external
 * plug-in), registered when the module loads.
 * A solo console registers none, so none of them is in its bundle.
 */
const registered: Partial<Record<Locale, MessageTree[]>> = {};
const pending: Partial<Record<Locale, Promise<MessageTree>>> = {};
let activeLocale: Locale = FALLBACK_LOCALE;

function importDictionary(locale: Locale): Promise<MessageTree> {
  if (locale === "fr") {
    return import("@openedbot/contracts-i18n/messages.fr").then(({ fr }) => fr);
  }
  return import("@openedbot/contracts-i18n/messages.en").then(({ en }) => en);
}

/** Load one locale chunk and reuse its in-flight import and loaded dictionary. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (dictionaries[locale]) return;
  let loading = pending[locale];
  if (!loading) {
    loading = importDictionary(locale);
    pending[locale] = loading;
  }
  try {
    dictionaries[locale] = await loading;
  } catch (error) {
    delete pending[locale];
    throw error;
  }
}

/** Mark a loaded dictionary as the language used when a caller has no loaded locale. */
export function activateLocale(locale: Locale): void {
  if (!dictionaries[locale]) throw new Error(`Locale dictionary is not loaded: ${locale}`);
  activeLocale = locale;
}

export function isLocaleLoaded(locale: Locale): boolean {
  return dictionaries[locale] !== undefined;
}

function getByPath(tree: MessageTree, path: string): string | undefined {
  let current: string | MessageTree | undefined = tree;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === undefined) return undefined;
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
}

/** Adds a module's strings for one locale. Core keys win: a module cannot replace them. */
export function registerMessages(locale: Locale, tree: MessageTree): void {
  const trees = registered[locale] ??= [];
  if (!trees.includes(tree)) trees.push(tree);
}

function lookup(locale: Locale | undefined, path: string): string | undefined {
  if (locale === undefined) return undefined;
  const base = dictionaries[locale];
  const own = base ? getByPath(base, path) : undefined;
  if (own !== undefined) return own;
  for (const tree of registered[locale] ?? []) {
    const value = getByPath(tree, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Synchronous translation backed by the loaded locale, with an active-language fallback. */
export function t(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template =
    lookup(dictionaries[locale] ? locale : activeLocale, key) ??
    lookup(FALLBACK_LOCALE, key) ??
    key;
  if (!params) return template;
  let output = template;
  for (const [name, value] of Object.entries(params)) {
    // Fonction de remplacement : une chaîne interpréterait `$&`, `$$` ou `$'` dans la valeur.
    output = output.replaceAll(`{${name}}`, () => String(value));
  }
  return output;
}

/** Check the loaded dictionaries; their key sets are kept equal by the contract parity test. */
export function hasMessage(key: string): boolean {
  return Object.values(dictionaries).some((dictionary) => getByPath(dictionary, key) !== undefined)
    || Object.values(registered).some((trees) => trees.some((tree) => getByPath(tree, key) !== undefined));
}
