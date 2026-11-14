/**
 * i18n foundation: pure TypeScript, no dependency, importable by the web
 * (React/Vite) and mobile (Expo/React Native) without ever loading
 * `react-native`: it is the only hard constraint of L7, `bun test` cannot
 * transpile its Flow entry point.
 *
 * No ICU here: a `{nom}` interpolation and a two-form plural
 * are enough for the size of the product. `i18next` or equivalent would be one
 * more dependency for a need this file covers in about a hundred
 * lines.
 */
import { DEFAULT_LOCALE, FALLBACK_LOCALE, type Locale } from "@openedbot/contracts-locale";
import { en } from "./messages.en";
import { fr } from "./messages.fr";

// The locale (type, default, fallback, detection) is a contract: its callers
// import it from `@openedbot/contracts-locale`, this foundation does not re-export it.

const DICTIONARIES: Record<Locale, MessageTree> = { fr, en };

/** Message tree: a string at a leaf, a namespace at a node. */
export type MessageTree = { readonly [key: string]: string | MessageTree };

/** Every key as a dotted path, computed from the FR dictionary. */
export type MessagePaths<T, Prefix extends string = ""> = T extends string
  ? Prefix
  : {
      [K in keyof T & string]: MessagePaths<T[K], `${Prefix}${Prefix extends "" ? "" : "."}${K}`>;
    }[keyof T & string];

/**
 * The core console's keys. A console module types and registers its own
 * strings (`defineMessages`, `@openedbot/browser-i18n`), so none is here.
 */
export type MessageKey = MessagePaths<typeof fr>;

function getByPath(tree: MessageTree, path: string): string | undefined {
  let cur: string | MessageTree | undefined = tree;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === undefined) return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Translates a key. A key absent from the active locale falls back to
 * French (the fallback required by US-I18N-01) then, as a last resort, returns the key
 * itself rather than throwing: a screen must never crash for a
 * missing string.
 */
export function t(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template =
    getByPath(DICTIONARIES[locale], key) ?? getByPath(DICTIONARIES[FALLBACK_LOCALE], key) ?? key;
  if (!params) return template;
  let out = template;
  for (const [name, value] of Object.entries(params)) {
    out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}

/**
 * Is a key actually carried by a dictionary?
 *
 * `t()` returns the key itself when it is missing, which is the right fallback for
 * a static label but not for a key built at runtime from an
 * API error code: the screen would show `login.failed.XXX` to
 * the user. A caller that builds its key tests here and chooses its
 * own generic message.
 */
export function hasMessage(key: string): boolean {
  return (
    getByPath(DICTIONARIES[FALLBACK_LOCALE], key) !== undefined ||
    getByPath(DICTIONARIES[DEFAULT_LOCALE], key) !== undefined
  );
}

// `plural`, `formatDate` and `formatNumber` serve only the screens: they
// live in `@openedbot/browser-i18n` (browser/i18n/src/format.ts).

export { en, fr };
